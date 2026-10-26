import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { createSourceImagesQueue } from "../backend/source-images.ts";

const resources = await sourceResourceFixture(), { app, headers, host, disk, database, capacity } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("配图持久任务在低磁盘和采集关闭时不下载，恢复后同ID零重试完成", async () => {
  capacity.diskBytes = 5_500_000_000; await resources.warm(); process.env.COLLECT_ENABLED = "true";
  const queue = createSourceImagesQueue({ host, disk, database });
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "image-resource", name: "配图资源测试", kind: "rss", config: { feedUrl: "https://source-image-resource.example/feed" } } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "image-resource", title: "制作步骤配图", url: "https://source-image-resource.example/article", via: "import",
    bodyText: "设置参考图。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-image-resource.example/one.png" }] });
  const path = `/api/admin/studio/intelligence/news:${saved.articleId}/images`, versionKey = (await app.inject({ url: path, headers })).json().versionKey;
  let requests = 0;
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#345678" } }).png().toBuffer();
  transport.get("https://source-image-resource.example").intercept({ path: "/one.png" }).reply(() => { requests++; return { statusCode: 200, data: png }; });
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { versionKey } })).statusCode, 200);
  const boss = await getBoss(), [pending] = await boss.findJobs(queue.name); assert.ok(pending);
  const stop = await workModuleQueues(boss);
  try {
    await delay(2200); assert.equal(requests, 0);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "created");
    process.env.COLLECT_ENABLED = "false"; capacity.diskBytes = 6_100_000_000; await resources.warm();
    await delay(2200); assert.equal(requests, 0);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0);
    process.env.COLLECT_ENABLED = "true";
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && (await app.inject({ url: path, headers })).json().state !== "ready") await delay(50);
    assert.equal((await app.inject({ url: path, headers })).json().state, "ready"); assert.equal(requests, 1);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0);
    transport.assertNoPendingInterceptors();
  } finally { await stop(); }
});
