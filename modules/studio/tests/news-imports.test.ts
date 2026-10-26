import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { studio } from "../server.ts";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { createNewsImportQueue } from "../backend/news-imports.ts";
import { workModuleQueues } from "@aihot/backend/jobs/queue";
import { setTimeout as delay } from "node:timers/promises";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
const endpoint = "/api/admin/studio/news-imports";
const body = "先建立角色参考图，再生成同一角色的近景和远景。每次改变镜头时保留角色参考和画面比例，检查服装、脸型和发色。先做短镜头对照，确认一致后再增加动作。".repeat(5);

test("粘贴未收录新闻链接进入持久任务，完成后在私有情报取得真实正文，不订阅网站或写入公开页面", async () => {
  process.env.COLLECT_ENABLED = "true";
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload: { url: "https://reference-news.example/film" } })).statusCode, 401);
  const added = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: "https://reference-news.example/film?utm_source=copy" } });
  assert.equal(added.statusCode, 200, "应能提交普通新闻网页，不限于平台作品");
  assert.equal(added.json().queued, true); const id = added.json().item.id;
  assert.equal((await app.inject({ url: `${endpoint}/${id}` })).statusCode, 401);
  assert.equal((await app.inject({ url: `${endpoint}/${id}`, headers })).json().state, "queued");
  transport.get("https://reference-news.example").intercept({ path: "/film?utm_source=copy" }).reply(200,
    `<html lang="zh-CN"><head><title>角色一致性制作方法</title></head><body><article><h1>角色一致性制作方法</h1><p>${body}</p><img src="/sample.png" alt="角色参考图"></article></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  const queue = studio.queues!.find(item => item.name === "studio.news.import")!, boss = await getBoss();
  assert.ok(queue); const [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const status = await app.inject({ url: `${endpoint}/${id}`, headers });
  assert.equal(status.headers["cache-control"], "no-store"); assert.equal(status.json().state, "ready");
  const detail = await app.inject({ url: `/api/admin/studio/intelligence/${status.json().materialId}`, headers });
  assert.equal(detail.statusCode, 200); assert.equal(detail.json().title, "角色一致性制作方法");
  assert.ok(detail.json().body.includes(body)); assert.equal(detail.json().bodyState, "ok");
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${status.json().materialId}` })).statusCode, 401);
  const sources = (await app.inject({ url: "/api/admin/studio/news-sources", headers })).json().rows;
  assert.equal(sources.filter((source: { enabled: boolean }) => source.enabled).length, 0, "单篇导入不会启用网站订阅");
  const reused = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: "https://reference-news.example/film#part1" } });
  assert.equal(reused.statusCode, 200); assert.equal(reused.json().queued, false);
  assert.equal(reused.json().item.materialId, status.json().materialId);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().total, 1);
  const publicDetail = await app.inject({ url: `/api/site/items/${status.json().materialId.slice(5)}` });
  assert.equal(publicDetail.statusCode, 404);
  assert.ok(!publicDetail.body.includes(body), "私有导入不能成为公开正文");
  transport.assertNoPendingInterceptors();
});

test("已收录但尚缺正文的新闻补齐正文且保留原标题和来源，已有可靠全文直接复用不再请求", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "known-news-import", name: "原始影视新闻源", kind: "rss", config: { feedUrl: "https://known-news.example/rss" }, enabled: false } })).statusCode, 200);
  const original = await upsertMaterial({ sourceId: "known-news-import", url: "https://known-news.example/article", title: "原新闻标题", excerpt: "原始摘要", bodyStatus: "pending", via: "import" });
  const added = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: "https://known-news.example/article" } });
  assert.equal(added.statusCode, 200); assert.equal(added.json().queued, true);
  transport.get("https://known-news.example").intercept({ path: "/article" }).reply(200,
    `<html><head><title>网页变更的标题</title></head><body><article><h1>另一标题</h1><p>${body}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
  const queue = studio.queues!.find(item => item.name === "studio.news.import")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/news:${original.articleId}`, headers })).json();
  assert.equal(detail.bodyState, "ok", "导入不能将缺正文旧新闻标成原稿已准备而实际仍空");
  assert.ok(detail.body.includes(body)); assert.equal(detail.title, "原新闻标题"); assert.equal(detail.source.id, "known-news-import");
  process.env.COLLECT_ENABLED = "false";
  const reused = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: "https://known-news.example/article?utm_source=again" } });
  assert.equal(reused.statusCode, 200); assert.equal(reused.json().queued, false); assert.equal(reused.json().item.materialId, `news:${original.articleId}`);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/news:${original.articleId}`, headers })).json().body, detail.body);
  process.env.COLLECT_ENABLED = "true"; transport.assertNoPendingInterceptors();
});

test("验证页不冒充新闻正文，失败只在明确重试后再排队，旧任务不能覆盖新任务", async () => {
  const url = "https://news-challenge.example/article";
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { url } });
  assert.equal(submitted.statusCode, 200); const id = submitted.json().item.id;
  const queue = studio.queues!.find(item => item.name === "studio.news.import")!, boss = await getBoss();
  const [old] = await boss.fetch(queue.name); assert.ok(old);
  transport.get("https://news-challenge.example").intercept({ path: "/article" }).reply(200,
    `<html><head><title>安全验证</title></head><body><article><h1>请完成验证后继续</h1><p>${"请点击下方按钮证明您不是机器人，验证通过后再继续访问当前网站。".repeat(20)}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
  await assert.rejects(queue.run([old.data] as never[]), /新闻原稿未读取完成/); await boss.fail(queue.name, old.id);
  const failed = (await app.inject({ url: `${endpoint}/${id}`, headers })).json();
  assert.equal(failed.state, "failed"); assert.equal(failed.materialId, null);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { url } })).json().queued, false);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { url, retryFailed: true } })).json().queued, true);
  await queue.run([old.data] as never[]);
  assert.equal((await app.inject({ url: `${endpoint}/${id}`, headers })).json().state, "queued");
  transport.get("https://news-challenge.example").intercept({ path: "/article" }).reply(200,
    `<html><head><title>已恢复的新闻</title></head><body><article><h1>已恢复的新闻</h1><p>${body}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
  const [retry] = await boss.fetch(queue.name); assert.ok(retry); await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
  assert.equal((await app.inject({ url: `${endpoint}/${id}`, headers })).json().state, "ready");
  transport.assertNoPendingInterceptors();
});

test("原发身份归并和再次发布也不能公开手动导入原稿，手动原稿收纳来源不能启用自动采集", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "private-paper-publisher", name: "明确原发站点", kind: "rss", tier: "T1", enabled: false,
      config: { feedUrl: "https://private-paper.example/feed", publisherUrlPrefixes: ["https://private-paper.example/"] } } })).statusCode, 200);
  const added = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: "https://private-paper.example/report" } });
  assert.equal(added.statusCode, 200);
  transport.get("https://private-paper.example").intercept({ path: "/report" }).reply(200,
    `<html><head><title>私有写作参考</title></head><body><article><h1>私有写作参考</h1><p>${body}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
  const queue = studio.queues!.find(item => item.name === "studio.news.import")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const item = (await app.inject({ url: `${endpoint}/${added.json().item.id}`, headers })).json();
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${item.materialId}`, headers })).json();
  assert.equal(detail.source.id, "private-paper-publisher", "确实经过原发归并，不能仅靠初始来源isolated保护");
  await publishArticle(item.materialId.slice(5));
  for (const path of [`/api/site/items/${item.materialId.slice(5)}`, `/api/site/items/${item.materialId.slice(5)}/original`, `/items/${item.materialId.slice(5)}/markdown`])
    assert.equal((await app.inject({ url: path })).statusCode, 404);
  const folder = (await app.inject({ url: "/api/admin/studio/news-sources?q=studio-news-references", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/sources/studio-news-references", headers,
    payload: { version: folder.version, patch: { enabled: true } } })).statusCode, 400, "原稿收纳来源不是可订阅的网站");
  transport.assertNoPendingInterceptors();
});

test("新闻链接需CSRF和HTTP地址，私网/非HTML/超限/短摘要失败而不伪造正文", async () => {
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers: { cookie: headers.cookie }, payload: { url: "https://news-invalid.example/page" } })).statusCode, 403);
  for (const url of ["file:///etc/passwd", "https://user:secret@news-invalid.example/page", "not-a-link"])
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { url } })).statusCode, 400);
  const queue = studio.queues!.find(item => item.name === "studio.news.import")!, boss = await getBoss();
  for (const sample of [
    { url: "http://169.254.169.254/latest/meta-data", private: true },
    { url: "https://news-invalid.example/image", type: "image/png", text: "image-data" },
    { url: "https://news-invalid.example/large", type: "text/html", text: "x".repeat(6 * 1024 ** 2 + 1) },
    { url: "https://news-invalid.example/short", type: "text/html", text: "<html><head><title>摘要</title></head><body><article>只有几句摘要</article></body></html>" },
  ]) {
    if (sample.type) transport.get("https://news-invalid.example").intercept({ path: new URL(sample.url).pathname }).reply(200, sample.text!, { headers: { "content-type": sample.type } });
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { url: sample.url } });
    assert.equal(submitted.statusCode, 200); const [job] = await boss.fetch(queue.name); assert.ok(job);
    if (sample.private) config.allowPrivateNetworkFetch = false;
    try { await assert.rejects(queue.run([job.data] as never[]), /新闻原稿未读取完成/); }
    finally { config.allowPrivateNetworkFetch = true; }
    await boss.fail(queue.name, job.id);
    const item = (await app.inject({ url: `${endpoint}/${submitted.json().item.id}`, headers })).json();
    assert.equal(item.state, "failed"); assert.equal(item.materialId, null); assert.equal(item.errorCode, "page_unavailable");
  }
  transport.assertNoPendingInterceptors();
});

test("低磁盘和持久暂停保留原导入任务；在途暂停不提交原稿，恢复并重启消费者后同ID零重试完成", { timeout: 25_000 }, async () => {
  const url = "https://news-resume.example/film";
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { url } }); assert.equal(submitted.statusCode, 200);
  const queue = createNewsImportQueue(resources), boss = await getBoss();
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const [job] = await boss.findJobs(queue.name, { queued: true }); assert.ok(job);
  const control = async (enabled: boolean) => {
    const before = (await app.inject({ url: "/api/admin/studio/collection-operations", headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/collection-operations", headers, payload: { version: before.version, enabled } })).statusCode, 200);
  };
  let requests = 0, announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  transport.get("https://news-resume.example").intercept({ path: "/film" }).reply(() => {
    requests++; announce(); return { statusCode: 200, data: `<html><head><title>恢复后读到的原稿</title></head><body><article><p>${body}</p></article></body></html>`,
      responseOptions: { headers: { "content-type": "text/html" } } };
  }).delay(400).times(2);
  resources.capacity.diskBytes = 5_500_000_000; await resources.warm();
  let stop = await workModuleQueues(boss);
  try {
    await delay(2200); assert.equal(requests, 0); await control(false);
    resources.capacity.diskBytes = 6_100_000_000; await resources.warm(); await delay(2200); assert.equal(requests, 0);
    await control(true); await started; await control(false); await delay(650);
    const waiting = (await app.inject({ url: `${endpoint}/${submitted.json().item.id}`, headers })).json();
    assert.equal(waiting.state, "queued"); assert.equal(waiting.materialId, null);
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "created");
    await stop(); await control(true); stop = await workModuleQueues(boss); await resources.warm();
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && (await boss.findJobs(queue.name, { id: job.id }))[0]!.state !== "completed") await delay(40);
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "completed");
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.retryCount, 0);
    assert.equal((await app.inject({ url: `${endpoint}/${submitted.json().item.id}`, headers })).json().state, "ready");
    assert.equal(requests, 2); transport.assertNoPendingInterceptors();
  } finally { await stop(); await control(true); }
});
