import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { paidRequest, readSavedReceipt, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts, recoverStaleWork } from "@aihot/backend/operations/recover";

after(async () => { await stopBoss(); await closeDb(); });

test("工作台拒绝旧编辑链的新任务，保留来源和正文队列；未安装工作台的原新闻模式仍可入队", async () => {
  installModules(SERVER_MODULES);
  const boss = await getBoss();
  for (const name of [QUEUES.analyze, QUEUES.group, QUEUES.digest, QUEUES.notifySelected, QUEUES.prepareMedia, QUEUES.republishSource]) {
    const id = await enqueue(name, { articleId: "private-news", storyId: -1, sourceId: "private-source" });
    assert.equal(id, null, `${name}不能因旧入口残留产生永不执行的待办`);
    assert.equal(await boss.getQueue(name), null, "拒绝登记也不创建无用队列");
  }
  assert.ok(await enqueue(QUEUES.fetchSource, { sourceId: "private-source" }));
  assert.ok(await enqueue(QUEUES.extractBody, { articleId: "private-news" }));
  installModules([]);
  assert.ok(await enqueue(QUEUES.analyze, { articleId: "legacy-news" }), "无工作台时沿原新闻处理合同");
});

test("共享恢复只自动放行仍启用链的未知回执，不复活旧付费请求或建立旧归组队列", async () => {
  installModules(SERVER_MODULES);
  const legacy = { service: "pipeline-local-fixture", purpose: "summarize_article", subject: "article:old", identity: { request: "legacy-lost" } };
  const studio = { ...legacy, purpose: "studio_material_analysis", subject: "studio:news", identity: { request: "studio-lost" } };
  const lostResponse = async () => { throw new Error("local provider response lost"); };
  await assert.rejects(paidRequest(legacy, lostResponse), /local provider response lost/);
  await assert.rejects(paidRequest(studio, lostResponse), /local provider response lost/);
  assert.equal((await autoReleaseUnknownReceipts(Date.now() + 31 * 60_000)).released, 1, "仅Studio回执按原规则自动放行一次");
  await assert.rejects(readSavedReceipt(legacy), ReceiptUnknownError);
  assert.equal(await readSavedReceipt(studio), null);
  assert.equal((await recoverStaleWork()).grouping.enqueued, 0);
  assert.equal(await (await getBoss()).getQueue(QUEUES.group), null, "恢复不再为已停用归组建立空队列");
});
