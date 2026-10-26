import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { access, readFile, writeFile, unlink } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { windowsDeletePermissionScript } from "../../../tests/windows-delete-permission.ts";
import { gate, stub } from "../../../tests/setup.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";
import { topicReviewQueue } from "../backend/topic-review.ts";
import sharp from "sharp";
import { createImageAssets } from "../backend/image-assets.ts";
import { writingGenerationQueue } from "../backend/writing-generation.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
transport.enableNetConnect(/127\.0\.0\.1/);
const analyzedInputs: Array<{ material: { body: string; transcript: { visualEvidence: string } } }> = [];
const modelInputs: Array<{ task?: string; materials?: unknown[]; parts?: Array<{ content: string }>; snapshot?: { materials: unknown[] } }> = [];
const provider = await stub((_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content); analyzedInputs.push(input);
  modelInputs.push(input);
  if (input.task?.startsWith("writing_")) {
    const spoken = "先保存检查结果，再清理媒体。必要画面还未观察时，不把只有转写说成完整画面分析。";
    const result = input.task === "writing_draft" ? { content: { spoken, production: "录屏展示检查结果的保存与清理顺序。", notes: "画面分析仍有缺口。" },
      facts: [{ materialId: input.snapshot.materials[0].id, quote: "先保存检查结果，再清理媒体。", claim: "先保存再清理" }], expressionReferences: [],
      shots: [{ startSeconds: 0, endSeconds: 30, visual: "检查结果与清理记录", captureMethod: "screen_recording", assetIds: [] }] }
      : input.task === "writing_polish" ? { spoken } : { passed: true, issues: [] };
    return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
  }
  if (input.task === "review_packet" || input.task === "review_summary") {
    const result = input.task === "review_packet" ? { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: [] }
      : { passed: true, opinionIds: [], summary: "完整转写支撑步骤，未观察画面的边界保留" };
    return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
  }
  if (input.materials) {
    const materialId = input.materials[0].material.id;
    const result = { directions: [{ id: "saved-media", columnId: "practice", eventKey: "saved-media", question: "制作检查结果怎么留存", viewerBenefit: "知道先保存证据再清理的顺序",
      whyNow: "本期流程说明", angle: "用一个具体制作检查演示", usage: { steps: ["保存检查结果", "清理媒体"], conditions: ["已可靠保存"], limitations: ["尚未观察画面"] },
      titles: ["先保存检查结果再清理素材", "制作证据如何留存", "别把转写和画面理解混在一起"], preferredTitle: 0,
      structure: { opening: "提出制作问题", rhythm: "讲步骤与条件", ending: "说明画面观察的缺口" },
      references: [{ materialId, role: "fact", quote: "先保存检查结果，再清理媒体。", reason: "实际转写中的步骤" }], gates: { audience: true, evidence: true, benefit: true },
      dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } }],
      assignments: [{ materialId, columnId: "practice", disposition: "support", directionIds: ["saved-media"], reason: "制作流程依据" }] };
    return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
  }
  return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "保存后清理的制作流程", reason: "保留素材证据和操作步骤",
    viewerBenefit: "知道转写与素材清理的先后顺序", event: "制作素材管理", evidenceQuotes: ["先保存检查结果，再清理媒体。"],
    gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } }) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "local-asr-evidence-fixture-key", LLM_MODEL: "local-asr-evidence-fixture" });
let frozenBatchId = "";
after(async () => { setGlobalDispatcher(previous); await transport.close(); await provider.close(); await app.close(); await stopBoss(); await closeDb(); });

async function collectedVideo(description?: string) {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(added.statusCode, 200); const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport, { description }); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  return (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
}

test("本地识别结果可靠保存后立即删除下载媒体并归还预留，情报仍可读原简介与分段转写，重复处理不再次下载识别", async () => {
  const post = await collectedVideo(), endpoint = `/api/admin/studio/intelligence/creator:${post.id}`;
  const { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const bytes = Buffer.from("external-platform-media-fixture"), url = "https://media.example/fixture.mp4";
  transport.get("https://media.example").intercept({ path: "/fixture.mp4" }).reply(200, bytes, { headers: { "content-type": "video/mp4" } });
  let mediaFile = "", calls = 0;
  const processor = createMediaTranscriptionProcessor({
    resolve: async () => ({ url, kind: "audio" as const }),
    recognize: async (input: { file: string }) => {
      mediaFile = input.file; calls++; assert.deepEqual(await readFile(input.file), bytes);
      assert.equal((await createStorageWorkspaces().status()).reservedBytes, 520 * 1024 ** 2 + 1024);
      return { language: "zh", durationSeconds: 8, model: "external-asr-fixture", segments: [{ start: 0, end: 4, text: "先固定角色参考图。" }, { start: 4, end: 8, text: "再逐镜检查光线与人物。" }] };
    },
  });
  await processor.process(post.id);
  await assert.rejects(access(mediaFile), { code: "ENOENT" });
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  const detail = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(detail.body, "先锁定参考，再组织镜头"); assert.equal(detail.bodyState, "transcribed");
  assert.equal(detail.transcript.text, "先固定角色参考图。\n再逐镜检查光线与人物。");
  assert.equal(detail.transcript.segments[1].start, 4); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal(detail.transcript.model, "external-asr-fixture"); assert.equal(detail.transcript.visualEvidence, "not_observed");
  const search = await app.inject({ url: `/api/admin/studio/intelligence?q=${encodeURIComponent("逐镜检查光线")}`, headers });
  assert.equal(search.statusCode, 200); assert.equal(search.json().total, 1); assert.equal(search.json().rows[0].processingState, "transcribed");
  const historical = await app.inject({ url: `/api/admin/studio/history?q=${encodeURIComponent("光线")}`, headers });
  assert.equal(historical.statusCode, 200); assert.equal(historical.json().rows.length, 1);
  assert.equal(historical.json().rows[0].id, "creator:" + post.id);
  assert.ok(historical.json().rows[0].matchedTerms.includes("光线"));
  await processor.process(post.id); assert.equal(calls, 1);
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});

test("识别失败保留已完整下载的媒体且不冒充已转写，重建处理器后可复用它重试，保存成功才清理", async () => {
  const post = await collectedVideo("新增配音与镜头检查"), endpoint = `/api/admin/studio/intelligence/creator:${post.id}`;
  const { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const bytes = Buffer.from("complete-media-kept-for-limited-retry"), url = "https://media.example/retry.mp4";
  transport.get("https://media.example").intercept({ path: "/retry.mp4" }).reply(200, bytes);
  let mediaFile = "";
  const failed = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async input => {
    mediaFile = input.file; throw new Error("external recognizer unavailable");
  } });
  await assert.rejects(failed.process(post.id), /recognizer unavailable/);
  assert.deepEqual(await readFile(mediaFile), bytes);
  assert.equal((await app.inject({ url: endpoint, headers })).json().bodyState, "not_transcribed");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 520 * 1024 ** 2 + 1024);
  const resumed = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async input => {
    assert.equal(input.file, mediaFile); assert.deepEqual(await readFile(input.file), bytes);
    return { language: "zh", durationSeconds: 6, model: "external-asr-fixture", segments: [{ start: 0, end: 6, text: "配音完成后再检查镜头与口型。" }] };
  } });
  await assert.doesNotReject(resumed.process(post.id));
  assert.equal((await app.inject({ url: endpoint, headers })).json().transcript.text, "配音完成后再检查镜头与口型。");
  await assert.rejects(access(mediaFile), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  transport.assertNoPendingInterceptors();
});

test("Windows实际拒删时仍保留已保存转写和清理欠账，重启式补清理不再下载或识别，解除拒删后归还空间", { skip: process.platform !== "win32" }, async () => {
  const post = await collectedVideo("测试文件占用后的配音检查"), endpoint = `/api/admin/studio/intelligence/creator:${post.id}`;
  const { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/locked.mp4"; transport.get("https://media.example").intercept({ path: "/locked.mp4" }).reply(200, Buffer.from("download-to-be-locked"));
  let file = "", script = "";
  const permission = (restore = false) => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-LockedFile", file, ...(restore ? ["-Restore"] : [])], { windowsHide: true, timeout: 5000 });
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async input => {
    file = input.file; script = path.join(path.dirname(path.dirname(file)), "media-transcription-delete-permission.ps1");
    await writeFile(script, windowsDeletePermissionScript); await permission();
    return { language: "zh", durationSeconds: 7, model: "external-asr-fixture", segments: [{ start: 0, end: 7, text: "先保存检查结果，再清理媒体。" }] };
  } });
  try {
    const saved = await processor.process(post.id); assert.equal(saved.state, "ready");
    const detail = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(detail.transcript.text, "先保存检查结果，再清理媒体。"); assert.equal(detail.transcript.mediaState, "cleanup_pending");
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 520 * 1024 ** 2 + 1024); await access(file);
    const resumed = createMediaTranscriptionProcessor({ resolve: async () => { throw new Error("must not resolve platform"); }, recognize: async () => { throw new Error("must not recognize again"); } });
    assert.deepEqual(await resumed.cleanupPending(), { cleaned: 0, pending: 1 });
    await permission(true);
    assert.deepEqual(await resumed.cleanupPending(), { cleaned: 1, pending: 0 });
    assert.equal((await app.inject({ url: endpoint, headers })).json().transcript.mediaState, "cleaned");
    await assert.rejects(access(file), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  } finally { if (script) { await permission(true); await unlink(script); } }
  transport.assertNoPendingInterceptors();
});

test("媒体清理后的分段正文进入两日选题冻结材料，旧快照继续保留当时转写及未观察画面的边界", async t => {
  const startsAt = new Date(Date.now() - 3600_000).toISOString(), end = Date.parse(startsAt) + 48 * 3600_000;
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: plan.version, enabled: false, startsAt } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(end + 1) }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } }); assert.equal(frozen.statusCode, 200);
  frozenBatchId = frozen.json().batch.id;
  const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  const material = (await app.inject({ url: prefix + "/materials", headers })).json().rows[0]; assert.ok(material);
  assert.equal(material.bodyState, "transcribed"); assert.ok(material.body.includes("先保存检查结果，再清理媒体。"));
  assert.equal(material.transcript.segments[0].end, 7); assert.equal(material.transcript.visualEvidence, "not_observed");
  assert.equal(material.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
});

test("两个处理器不能并行重复下载或转写同一视频，运行中的媒体不能被另一请求处理", async () => {
  const post = await collectedVideo("测试转写单任务互斥"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const reached = gate<void>(), release = gate<void>(), url = "https://media.example/serial.mp4";
  transport.get("https://media.example").intercept({ path: "/serial.mp4" }).reply(200, Buffer.from("serial-video-media"));
  let calls = 0;
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async () => {
    calls++; reached.open(); await release.promise;
    return { language: "zh", durationSeconds: 3, model: "external-asr-fixture", segments: [{ start: 0, end: 3, text: "只启动一个转写任务。" }] };
  } });
  const first = processor.process(post.id); await reached.promise;
  try {
    const other = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async () => { throw new Error("must not start second recognition"); } });
    await assert.rejects(other.process(post.id), /已有.*转写|正在.*转写/); assert.equal(calls, 1);
  } finally { release.open(); await first; }
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("失败媒体只有限保留六小时，未到期不删，到期补清理只处理本项目临时目录并释放预留", async t => {
  const post = await collectedVideo("失败媒体有限保留"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/expires.mp4"; transport.get("https://media.example").intercept({ path: "/expires.mp4" }).reply(200, Buffer.from("failed-media-to-expire"));
  let mediaFile = "";
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async input => {
    mediaFile = input.file; throw new Error("external ASR failed");
  } });
  await assert.rejects(processor.process(post.id), /external ASR failed/);
  const original = path.join(config.dataDir, "user-original-video.mp4"); await writeFile(original, "user-original-must-stay");
  const now = Date.now(); t.mock.timers.enable({ apis: ["Date"], now: new Date(now + (6 * 60 - 1) * 60_000) });
  const restarted = createMediaTranscriptionProcessor({ resolve: async () => { throw new Error("must not download"); }, recognize: async () => { throw new Error("must not recognize"); } });
  assert.deepEqual(await restarted.cleanupExpired(), { cleaned: 0, pending: 0 }); await access(mediaFile);
  t.mock.timers.setTime(now + (6 * 60 + 1) * 60_000);
  assert.deepEqual(await restarted.cleanupExpired(), { cleaned: 1, pending: 0 });
  await assert.rejects(access(mediaFile), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  assert.equal(await readFile(original, "utf8"), "user-original-must-stay"); await unlink(original);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  transport.assertNoPendingInterceptors();
});

test("数据库实际拒绝保存转写时不能删除唯一下载媒体或标成功，恢复数据库写入后可从原媒体重试", async () => {
  const post = await collectedVideo("数据库暂时拒绝保存转写"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/database-failure.mp4", bytes = Buffer.from("keep-until-real-database-commit");
  transport.get("https://media.example").intercept({ path: "/database-failure.mp4" }).reply(200, bytes);
  let mediaFile = "";
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "audio" as const }), recognize: async input => {
    mediaFile = input.file; return { language: "zh", durationSeconds: 5, model: "external-asr-fixture", segments: [{ start: 0, end: 5, text: "结果写入成功之后才能清理。" }] };
  } });
  // Real throwaway-DB fault injection, not a private-table assertion or an internal collaborator mock.
  await sql.unsafe("CREATE FUNCTION studio_transcription_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled database persist failure'; END $$");
  await sql.unsafe("CREATE TRIGGER studio_transcription_test_failure BEFORE INSERT OR UPDATE ON studio_media_transcripts FOR EACH ROW EXECUTE FUNCTION studio_transcription_test_failure()");
  try {
    await assert.rejects(processor.process(post.id), /controlled database persist failure/);
    assert.deepEqual(await readFile(mediaFile), bytes);
    assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 520 * 1024 ** 2 + 1024);
  } finally {
    await sql.unsafe("DROP TRIGGER studio_transcription_test_failure ON studio_media_transcripts");
    await sql.unsafe("DROP FUNCTION studio_transcription_test_failure()");
  }
  await processor.process(post.id);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().transcript.text, "结果写入成功之后才能清理。");
  await assert.rejects(access(mediaFile), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  transport.assertNoPendingInterceptors();
});

test("已持久化且清理媒体的完整转写可作为选题事实材料，不会仍被当成未取得正文，后续更新不改旧快照", async () => {
  await resources.warm(); config.modelCallsEnabled = true;
  const prefix = `/api/admin/studio/topic-batches/${frozenBatchId}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(analysis.rows[0].disposition, "support"); assert.equal(analysis.rows[0].gates.evidence, true);
  assert.ok(analyzedInputs[0]!.material.body.includes("先保存检查结果，再清理媒体。"));
  assert.equal(JSON.stringify(analyzedInputs[0]!.material).split("先保存检查结果，再清理媒体。").length - 1, 1);
  assert.equal(analyzedInputs[0]!.material.transcript.visualEvidence, "not_observed");
  const material = (await app.inject({ url: prefix + "/materials", headers })).json().rows[0];
  assert.ok(material.body.includes("先保存检查结果，再清理媒体。")); assert.ok(!material.body.includes("数据库暂时拒绝保存转写"));
});

test("完整本地转写可以支撑综合选题的事实门槛，不因删除原媒体被降为缺失证据", async () => {
  const endpoint = `/api/admin/studio/topic-batches/${frozenBatchId}/recommendations`;
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const recommendation = (await app.inject({ url: endpoint, headers })).json().result.directions[0];
  assert.equal(recommendation.gates.evidence, true); assert.equal(recommendation.score.eligible, true);
});

test("转写支撑的选题审核后可以采纳为独立稿件并提交写稿，不能仍按缺少必要转写拒绝", async () => {
  const review = `/api/admin/studio/topic-batches/${frozenBatchId}/review`;
  assert.equal((await app.inject({ method: "POST", url: review, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: frozenBatchId, directionIds: ["saved-media"] } });
  assert.equal(created.statusCode, 200); const draft = (await app.inject({ url: `/api/admin/studio/drafts/${created.json().id}`, headers })).json();
  assert.equal(draft.snapshot.materials[0].bodyState, "transcribed");
  const generated = await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${draft.id}/generation`, headers, payload: { version: draft.version } });
  assert.equal(generated.statusCode, 200); assert.equal(generated.json().queued, true);
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
});

test("实际下载的是视频而必要画面证据尚未交付时不能清理原视频或伪装成完整处理成功", async t => {
  const post = await collectedVideo("视频必要画面证据未齐"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/visuals-pending.mp4", bytes = Buffer.from("external-video-with-visual-evidence-required");
  transport.get("https://media.example").intercept({ path: "/visuals-pending.mp4" }).reply(200, bytes);
  let mediaFile = "";
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "video" as const }), recognize: async input => {
    mediaFile = input.file; return { language: "zh", durationSeconds: 4, model: "external-asr-fixture", segments: [{ start: 0, end: 4, text: "只有转写，还没有取得必要画面。" }] };
  } });
  await assert.rejects(processor.process(post.id), /画面|关键帧/);
  assert.deepEqual(await readFile(mediaFile), bytes);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.now() + (6 * 60 + 1) * 60_000) });
  assert.equal((await processor.cleanupExpired()).cleaned, 1);
});

test("必要关键帧与转写一起可靠保存后才删除视频，受保护的私有画面在媒体清理和后续更新后仍可读取", async t => {
  const post = await collectedVideo("视频关键帧与分段证据"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/with-frames.mp4", bytes = Buffer.from("external-video-source"),
    png = await sharp({ create: { width: 160, height: 90, channels: 3, background: "#245f54" } }).png().toBuffer();
  transport.get("https://media.example").intercept({ path: "/with-frames.mp4" }).reply(200, bytes);
  let mediaFile = "";
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "video" as const }), recognize: async input => {
    mediaFile = input.file; return { language: "zh", durationSeconds: 8, model: "external-asr-fixture",
      segments: [{ start: 0, end: 8, text: "先展示分镜，再讲解人物一致性的操作。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }, { timeSeconds: 6, pngBase64: png.toString("base64") }] };
  } });
  await processor.process(post.id); await assert.rejects(access(mediaFile), { code: "ENOENT" });
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.visualEvidence, "keyframes_saved"); assert.equal(detail.transcript.frames.length, 2);
  assert.equal(detail.transcript.frames[1].timeSeconds, 6); assert.equal(detail.transcript.frames[0].pngBase64, undefined);
  const frameUrl = detail.transcript.frames[0].url;
  assert.match(frameUrl, /^\/api\/admin\/studio\/image-assets\/[a-f0-9]{64}$/);
  assert.equal((await app.inject({ url: frameUrl })).statusCode, 401);
  const frame = await app.inject({ url: frameUrl, headers }); assert.equal(frame.statusCode, 200);
  assert.equal((await sharp(frame.rawPayload).metadata()).width, 160);
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  // Retiring a source revision cannot remove picture evidence already referenced by history.
  await collectedVideo("该视频说明后来更新");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.now() + 40 * 86400_000) });
  await createImageAssets().prune(new Date());
  assert.equal((await app.inject({ url: frameUrl, headers })).statusCode, 200);
  transport.assertNoPendingInterceptors();
});

test("综合选题、独立审核与写稿均只发送一份完整转写正文并保留时间元数据，历史原件仍含完整分段", async () => {
  const boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  const directions = modelInputs.find(input => input.materials), review = modelInputs.find(input => input.task === "review_packet"), writing = modelInputs.find(input => input.task === "writing_draft");
  assert.ok(directions); assert.ok(review); assert.ok(writing);
  const reviewMaterial = JSON.parse(review.parts!.map(part => part.content).join(""));
  for (const value of [(directions.materials![0] as { material: unknown }).material, reviewMaterial, writing.snapshot!.materials[0]]) {
    assert.equal(JSON.stringify(value).split("先保存检查结果，再清理媒体。").length - 1, 1);
    const material = value as { transcript: { textLocation: string; segments: Array<{ start: number; end: number; characters: number; text?: string }> } };
    assert.equal(material.transcript.textLocation, "body"); assert.equal(material.transcript.segments[0]!.start, 0);
    assert.equal(material.transcript.segments[0]!.end, 7); assert.equal(material.transcript.segments[0]!.text, undefined); assert.ok(material.transcript.segments[0]!.characters > 0);
  }
  const original = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozenBatchId}/materials`, headers })).json().rows[0];
  assert.equal(original.transcript.text, "先保存检查结果，再清理媒体。"); assert.equal(original.transcript.segments[0].text, original.transcript.text);
});

test("媒体已写但完成标记发布中断后，重建处理器可安全重下未发布文件并保存，不会永久EEXIST或提前识别残片", async t => {
  const post = await collectedVideo("下载完成标记写入中断"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/interrupted-download.mp4", bytes = Buffer.from("complete-download-with-unpublished-marker");
  transport.get("https://media.example").intercept({ path: "/interrupted-download.mp4" }).reply(200, bytes).times(2);
  let mediaFile = "", recognized = 0;
  const adapters = { resolve: async () => ({ url, kind: "audio" as const }), recognize: async (input: { file: string }) => {
    recognized++; assert.deepEqual(await readFile(input.file), bytes);
    return { language: "zh", durationSeconds: 3, model: "external-asr-fixture", segments: [{ start: 0, end: 3, text: "下载必须完整发布后才能识别。" }] };
  } };
  const open = fs.open, fault = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (path.basename(String(args[0])) === "source.media") mediaFile = String(args[0]);
    if (path.basename(String(args[0])).startsWith("download.")) throw new Error("controlled marker publication interruption");
    return open(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(createMediaTranscriptionProcessor(adapters).process(post.id), /controlled marker publication interruption/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(recognized, 0); assert.deepEqual(await readFile(mediaFile), bytes);
  await createMediaTranscriptionProcessor(adapters).process(post.id);
  assert.equal(recognized, 1); await assert.rejects(access(mediaFile), { code: "ENOENT" });
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("识别检查点已完整而数据库暂时拒写时，上游随后不可访问也能在重建后恢复保存，不会丢掉已识别结果", async () => {
  const post = await collectedVideo("完整本地结果不再依赖上游"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/offline-recovery.mp4", bytes = Buffer.from("media-already-downloaded-for-local-recovery");
  transport.get("https://media.example").intercept({ path: "/offline-recovery.mp4" }).reply(200, bytes);
  let unavailable = false, coldRecognitions = 0, mediaFile = "";
  const adapters = { resolve: async () => { if (unavailable) throw new Error("upstream resolution unavailable"); return { url, kind: "audio" as const }; },
    recognize: async (input: { file: string }) => {
      mediaFile = input.file; const checkpoint = path.join(path.dirname(input.file), "recognition.json");
      try { return JSON.parse(await readFile(checkpoint, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      coldRecognitions++;
      const result = { language: "zh", durationSeconds: 4, model: "external-asr-fixture", segments: [{ start: 0, end: 4, text: "保留并恢复已经识别完成的本地结果。" }] };
      await writeFile(checkpoint, JSON.stringify(result)); return result;
    } };
  await sql.unsafe("CREATE FUNCTION studio_transcription_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled recovery persist failure'; END $$");
  await sql.unsafe("CREATE TRIGGER studio_transcription_recovery_failure BEFORE INSERT OR UPDATE ON studio_media_transcripts FOR EACH ROW EXECUTE FUNCTION studio_transcription_recovery_failure()");
  try { await assert.rejects(createMediaTranscriptionProcessor(adapters).process(post.id), /controlled recovery persist failure/); }
  finally { await sql.unsafe("DROP TRIGGER studio_transcription_recovery_failure ON studio_media_transcripts"); await sql.unsafe("DROP FUNCTION studio_transcription_recovery_failure()"); }
  assert.equal(coldRecognitions, 1); unavailable = true;
  await createMediaTranscriptionProcessor(adapters).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "保留并恢复已经识别完成的本地结果。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal(coldRecognitions, 1); await assert.rejects(access(mediaFile), { code: "ENOENT" });
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("有完整平台字幕时优先保存原字幕并只提取必要关键帧，不启动ASR模型，清理媒体后仍可查分段和出处", async () => {
  const post = await collectedVideo("可靠字幕优先与必要画面"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const url = "https://media.example/subtitle-first.mp4", bytes = Buffer.from("external-video-for-visuals-only");
  transport.get("https://media.example").intercept({ path: "/subtitle-first.mp4" }).reply(200, bytes);
  const png = await sharp({ create: { width: 160, height: 90, channels: 3, background: "#57635a" } }).png().toBuffer(); let mediaFile = "", frameReads = 0;
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "video" as const,
    subtitles: { language: "zh-CN", durationSeconds: 8, model: "bilibili:platform-subtitle:zh-CN", segments: [{ start: 0, end: 4, text: "先保存原平台提供的完整字幕。" }, { start: 4, end: 8, text: "再保留必要画面供后续分析。" }] } }),
    recognize: async () => { throw new Error("ASR must not run when complete platform subtitles are available"); },
    frames: async (input: { file: string }) => { mediaFile = input.file; frameReads++; assert.deepEqual(await readFile(input.file), bytes);
      return { durationSeconds: 8, frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }; },
  });
  await processor.process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.method, "platform_subtitle"); assert.equal(detail.transcript.model, "bilibili:platform-subtitle:zh-CN");
  assert.equal(detail.transcript.text, "先保存原平台提供的完整字幕。\n再保留必要画面供后续分析。"); assert.equal(detail.transcript.segments[1].start, 4);
  assert.equal(detail.transcript.visualEvidence, "keyframes_saved"); assert.equal(detail.transcript.mediaState, "cleaned"); assert.equal(frameReads, 1);
  await assert.rejects(access(mediaFile), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  transport.assertNoPendingInterceptors();
});

test("平台字幕与视频下载完成后取帧中断，重建时可离线恢复原字幕并保存，不重新下载或加载ASR", async () => {
  const post = await collectedVideo("字幕已有而取帧中断"), { createMediaTranscriptionProcessor } = await import("../backend/media-transcription.ts");
  const bytes = Buffer.from("complete-video-with-persisted-subtitles"), url = "https://media.example/caption-recovery.mp4";
  transport.get("https://media.example").intercept({ path: "/caption-recovery.mp4" }).reply(200, bytes);
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#4c6257" } }).png().toBuffer();
  let mediaFile = "";
  await assert.rejects(createMediaTranscriptionProcessor({
    resolve: async () => ({ url, kind: "video", subtitles: { language: "zh-CN", durationSeconds: 8, model: "bilibili:platform-subtitle:zh-CN",
      segments: [{ start: 0, end: 8, text: "取帧失败不丢弃已经完整取得的字幕。" }] } }),
    recognize: async () => { throw new Error("ASR must never replace existing subtitles"); },
    frames: async input => { mediaFile = input.file; throw new Error("controlled frame extraction interruption"); },
  }).process(post.id), /controlled frame extraction interruption/);
  assert.deepEqual(await readFile(mediaFile), bytes);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  await createMediaTranscriptionProcessor({
    resolve: async () => { throw new Error("upstream now unavailable"); },
    recognize: async () => { throw new Error("ASR model not available"); },
    frames: async input => { assert.deepEqual(await readFile(input.file), bytes); return { durationSeconds: 8, frames: [{ timeSeconds: 3, pngBase64: png.toString("base64") }] }; },
  }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.method, "platform_subtitle"); assert.equal(detail.transcript.text, "取帧失败不丢弃已经完整取得的字幕。");
  assert.equal(detail.transcript.segments[0].end, 8); assert.equal(detail.transcript.mediaState, "cleaned");
  await assert.rejects(access(mediaFile), { code: "ENOENT" }); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  transport.assertNoPendingInterceptors();
});



