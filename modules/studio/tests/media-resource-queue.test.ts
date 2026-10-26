import { gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { enqueue, getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { installModules, serverModules } from "@aihot/backend/modules";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import { createCollectionAdmission } from "../backend/collection-admission.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("原新闻模式的动画准备与通知预热在压力下保留任务，恢复后原ID执行且排空前监测不释放", async () => {
  const fixture = await sourceResourceFixture();
  await fixture.warm();
  const { app, headers, host, disk, database, capacity } = fixture;
  const media = createCollectionAdmission({ host, disk, database, heavy: true, enabled: () => true });
  // This is the original public-news consumer's compatibility contract. Reuse the Studio resource
  // Adapter without installing its private-pipeline ownership; production Studio keeps it disabled.
  installModules(serverModules().map(module => module.name === "studio" ? {
    ...module, editorialPipeline: undefined, publication: undefined, mediaPreparationAdmission: media,
  } : module));
  const previous = getGlobalDispatcher(), transport = new MockAgent();
  transport.disableNetConnect(); setGlobalDispatcher(transport);
  config.allowPrivateNetworkFetch = true;
  const enabled = process.env.COLLECT_ENABLED; process.env.COLLECT_ENABLED = "false";
  const entered = gate(), release = gate();
  let stopping: Promise<void> | undefined;
  let publication: ReturnType<typeof mock.method> | undefined;
  try {
    const frames = await sharp({ create: { width: 160, height: 1200, channels: 3,
      background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).raw().toBuffer();
    const gif = await sharp(frames, { raw: { width: 160, height: 1200, channels: 3, pageHeight: 120 } })
      .gif({ loop: 0, delay: Array(10).fill(90) }).toBuffer();
    const url = "https://media-resource.example/animation.gif";
    transport.get("https://media-resource.example").intercept({ path: "/animation.gif" }).reply(200, gif, { headers: { "content-type": "image/gif" } });
    const proxy = proxiedImage(url, "full")!;
    const original = await app.inject({ url: proxy });
    assert.equal(original.statusCode, 200);
    assert.equal(original.headers["content-type"], "image/gif");
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "media-notify-source", name: "预热来源", kind: "rss", participation_mode: "editorial",
        config: { feedUrl: "https://media-resource.example/feed" } } })).statusCode, 200);
    const { articleId } = await upsertMaterial({ sourceId: "media-notify-source", url: "https://media-resource.example/article",
      title: "AI影视制作流程", bodyText: "人物一致性操作步骤", bodyHtml: "<p>人物一致性操作步骤</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    const notifyId = await enqueue(QUEUES.notifySelected, { articleId });
    assert.ok(notifyId);
    const boss = await getBoss();
    const [imageJob] = (await boss.findJobs<{ url?: string }>(QUEUES.prepareMedia, {})).filter(job => job.data.url === url);
    assert.ok(imageJob);
    const before = (await app.inject({ url: "/api/admin/studio/image-storage", headers })).json().cacheBytes;
    await fixture.warm();
    capacity.diskBytes = 5_000_000_000; await disk.sample();
    assert.equal(disk.status().ingestionAllowed, true);
    await registerNotifyJobs(boss);
    await delay(5200);
    for (const [queue, id] of [[QUEUES.prepareMedia, imageJob.id], [QUEUES.notifySelected, notifyId]] as const) {
      const [job] = await boss.findJobs(queue, { id });
      assert.equal(job!.state, "created"); assert.equal(job!.retryCount, 0);
    }
    assert.equal((await app.inject({ url: "/api/admin/studio/image-storage", headers })).json().cacheBytes, before);
    capacity.diskBytes = 5_900_000_000; await disk.sample();
    await delay(5200);
    assert.equal((await boss.findJobs(QUEUES.prepareMedia, { id: imageJob.id }))[0]!.state, "created");
    assert.equal((await boss.findJobs(QUEUES.notifySelected, { id: notifyId }))[0]!.state, "created");
    const rename = fs.rename;
    publication = mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      const target = String(args[1]);
      if (target.includes("imgcache") && !target.endsWith(".type")) { entered.open(); await release.promise; }
      return rename(...args);
    });
    syncBuiltinESMExports();
    capacity.diskBytes = 6_000_000_000; await disk.sample();
    await Promise.race([entered.promise, delay(6500).then(() => { throw new Error("资源恢复后媒体任务未开始发布"); })]);
    stopping = stopBoss({ timeoutMs: 8000 });
    await delay(100);
    assert.equal(host.status().state, "ready");
    assert.throws(() => media(), /活动消费者/);
    release.open(); await stopping;
    assert.equal(host.status().state, "unavailable");
    const observer = await getBoss();
    for (const [queue, id] of [[QUEUES.prepareMedia, imageJob.id], [QUEUES.notifySelected, notifyId]] as const) {
      const [job] = await observer.findJobs(queue, { id });
      assert.equal(job!.state, "completed"); assert.equal(job!.retryCount, 0);
    }
    const prepared = await app.inject({ url: proxy });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.headers["content-type"], "image/webp");
    const meta = await sharp(prepared.rawPayload, { animated: true }).metadata();
    assert.equal(meta.pages, 10); assert.equal(meta.loop, 0); assert.deepEqual(meta.delay, Array(10).fill(90));
    // Refuse fresh cache writes: success must read the worker's warmed PNG, not render lazily here.
    const refuseWrite = mock.method(fs, "writeFile", async () => { throw new Error("controlled warmed-read-only check"); });
    syncBuiltinESMExports();
    try { assert.equal((await app.inject({ url: `/og/items/${articleId}.png` })).statusCode, 200); }
    finally { refuseWrite.mock.restore(); syncBuiltinESMExports(); }
    const next = media();
    try { assert.equal(next.canStart(), false); } finally { next.stop(); }
  } finally {
    release.open(); await stopping;
    publication?.mock.restore(); syncBuiltinESMExports();
    await stopBoss(); await app.close();
    setGlobalDispatcher(previous); await transport.close();
    if (enabled === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = enabled;
  }
});
