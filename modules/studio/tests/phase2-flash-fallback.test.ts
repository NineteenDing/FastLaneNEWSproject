import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("未保存网页连接时原环境连接也只能发送Flash，不能回退到旧Pro模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  const before = { url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  const previous = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  const body = "先准备角色参考图，再检查两个连续镜头的光线。";
  let sentModel = "";
  transport.get("https://phase2-flash.example").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
    sentModel = JSON.parse(String(request.body)).model;
    return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      columnId: "practice", disposition: "support", summary: "连续镜头光线检查", reason: "具体制作步骤", viewerBenefit: "检查角色一致性", event: "角色参考流程",
      evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true },
      dimensions: { audience: 90, practical: 80, evidence: 80, freshness: 70, demand: null, distinctiveness: 60 },
    }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
  });
  try {
    Object.assign(process.env, { LLM_BASE_URL: "https://phase2-flash.example/v1/", LLM_API_KEY: "private-phase2-fallback-key", LLM_MODEL: "deepseek-v4-pro" });
    assert.equal((await app.inject({ url: "/api/admin/studio/model-connection", headers })).json().state, "missing");
    await resources.warm();
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "phase2-flash-news", name: "Flash验证来源", kind: "rss", config: { feedUrl: "https://phase2-flash.example/feed" } } })).statusCode, 200);
    await upsertMaterial({ sourceId: "phase2-flash-news", title: "连续镜头参考流程", url: "https://phase2-flash.example/article", via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
    const batch = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
    assert.equal(batch.statusCode, 200, batch.body);
    const analysisUrl = `/api/admin/studio/topic-batches/${batch.json().batch.id}/analysis`;
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 200);
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.material-analysis")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    assert.equal((await app.inject({ url: analysisUrl, headers })).json().analyzed, 1);
    assert.equal(sentModel, "deepseek-flash");
  } finally {
    for (const [name, value] of Object.entries({ LLM_BASE_URL: before.url, LLM_API_KEY: before.key, LLM_MODEL: before.model })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = oldPrivate; await transport.close();
  }
});
