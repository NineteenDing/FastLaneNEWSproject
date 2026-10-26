import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import type { MediaRhythm } from "../contracts.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
const requests: { messages: Array<{ role: string; content: string }> }[] = [];
const quote = "先固定角色参考，再按步骤检查连续镜头。";
const provider = await stub((_hit, request) => {
  requests.push(JSON.parse(request.body));
  return { id: "rhythm-grounded-analysis", choices: [{ message: { content: JSON.stringify({
    columnId: "practice", disposition: "support", summary: "固定角色参考并检查连续镜头", reason: "有具体制作步骤", viewerBenefit: "减少角色漂移",
    event: "角色制作方法", evidenceQuotes: [quote], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: null, demand: null, distinctiveness: 60 },
  }) } }], usage: { prompt_tokens: 300, completion_tokens: 100 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "rhythm-fixture-key", LLM_MODEL: "rhythm-fixture-model" });
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("冻结材料的真实节奏随完整正文进入分析，模型同时收到观察限制与开头展开结尾的依据要求", { timeout: 25000 }, async t => {
  await resources.warm();
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://space.bilibili.com/20813884" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport); const boss = await getBoss(), [collect] = await boss.fetch(creatorQueue.name); assert.ok(collect);
  await creatorQueue.run([collect.data] as never[]); await boss.complete(creatorQueue.name, collect.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const rhythm: MediaRhythm = { version: 1, audio: { method: "rms_20ms_v1", timeBasis: "decoded_audio", observedSeconds: 8, quietThresholdDbfs: -40,
    minimumQuietSeconds: 0.3, quietSeconds: 1, quietIntervalCount: 1, quietIntervals: [{ start: 3, end: 4 }], truncated: false,
    windows: [{ start: 0, end: 8, rmsDbfs: -20, quietFraction: 0.125 }] }, visual: null };
  transport.get("https://media.example").intercept({ path: "/model-rhythm.wav" }).reply(200, "external-audio-fixture");
  await createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/model-rhythm.wav", kind: "audio" }),
    recognize: async () => ({ language: "zh", model: "external-asr-fixture", durationSeconds: 8, segments: [{ start: 0, end: 8, text: quote }], rhythm }) }).process(post.id);
  const startsAt = new Date(Date.parse(post.collectedAt) - 3600_000).toISOString();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, enabled: false, startsAt } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.parse(startsAt) + 48 * 3600_000 + 1000) }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } }); assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  assert.equal((await app.inject({ url, headers })).json().analyzed, 1);
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0]!.messages.find(message => message.role === "user")!.content);
  assert.deepEqual(input.material.transcript.rhythm, rhythm); assert.ok(input.material.body.includes(quote));
  assert.equal(input.material.transcript.text, undefined, "正文只投一份，时间和覆盖另附");
  const system = requests[0]!.messages.find(message => message.role === "system")!.content;
  for (const rule of ["低能量不等于说话停顿", "采样画面变化不等于精确切镜", "不能推断完播率", "开头、展开和结尾", "缺少rhythm"]) assert.ok(system.includes(rule), `缺少必要解释约束：${rule}`);
  transport.assertNoPendingInterceptors();
});
