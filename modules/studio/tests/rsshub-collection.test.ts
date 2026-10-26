import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { createBridgeQueue } from "../backend/rsshub-jobs.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
let feed = '<rss version="2.0"><channel><title>千问</title><item><title>AI视频镜头控制更新</title><link>https://qwen.example/update</link><pubDate>' + new Date().toUTCString() + '</pubDate><description>新的镜头控制方法</description></item></channel></rss>';
let status = 200;
let location: string | null = null;
let responseDelay = 0;
let active = 0;
let peak = 0;
const paths: string[] = [];
const upstream = createServer((req, res) => {
  active++; peak = Math.max(peak, active);
  res.once("close", () => { active--; });
  paths.push(req.url!);
  res.writeHead(status, { "content-type": "application/rss+xml", ...(location ? { location } : {}) });
  if (responseDelay) setTimeout(() => res.end(feed), responseDelay); else res.end(feed);
});
const base = await listenHttpForFetch(upstream);
const oldBase = process.env.STUDIO_RSSHUB_BASE_URL;
after(async () => {
  if (oldBase === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = oldBase;
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await app.close(); await stopBoss(); await closeDb();
});
let sessionHeaders: { cookie: string | undefined; "x-csrf-token": string } | undefined;
async function auth() {
  if (sessionHeaders) return sessionHeaders;
  config.adminPassword = "rsshub-collection-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=rsshub-collection-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  sessionHeaders = { cookie, "x-csrf-token": me.json().csrf as string };
  return sessionHeaders;
}

test("原external经可信本机RSSHub采集并复用原身份、RSS解析与去重，不放宽普通来源内网保护", async () => {
  const headers = await auth();
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  config.allowPrivateNetworkFetch = false;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "src-qwen-blog", name: "千问桥接采集", kind: "external", config: {} } })).statusCode, 200);
  const first = await collectSource("src-qwen-blog");
  assert.equal(first.status, "ok");
  assert.equal(first.created, 1);
  assert.deepEqual(paths, ["/qwen/blog?limit=8"]);
  assert.equal(config.allowPrivateNetworkFetch, false);
  const repeated = await collectSource("src-qwen-blog");
  assert.equal(repeated.status, "ok");
  assert.equal(repeated.created, 0);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-qwen-blog", headers })).json().rows[0];
  assert.equal(card.kind, "external");
  assert.equal(card.collectedCount, 1);
  assert.ok(card.lastCheckedAt);
  const detail = (await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json();
  assert.equal(detail.items[0].title, "AI视频镜头控制更新");
  assert.equal(detail.runs[0].status, "ok");
});

test("可信集成拒绝外部或带凭据配置与重定向；普通RSS仍不得访问本机", async () => {
  const headers = await auth();
  const before = paths.length;
  for (const address of ["https://foreign.example", "http://169.254.169.254", "http://localhost:1200", "http://127.0.0.1:1200/admin", "http://secret@127.0.0.1:1200", "http://127.0.0.1:1200?token=secret"]) {
    process.env.STUDIO_RSSHUB_BASE_URL = address;
    const result = await collectSource("src-qwen-blog");
    assert.equal(result.status, "failed");
    assert.ok(!String(result.error).includes("secret"));
  }
  assert.equal(paths.length, before, "非法地址不能发起请求");
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  status = 302; location = base + "/forbidden";
  assert.equal((await collectSource("src-qwen-blog")).status, "failed");
  assert.equal(paths.length, before + 1, "不跟随任何重定向");
  assert.ok(!paths.includes("/forbidden"));
  status = 200; location = null;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "ordinary-private-rss", name: "普通RSS内网防护", kind: "rss", config: { feedUrl: base + "/blocked" } } })).statusCode, 200);
  const ordinary = await collectSource("ordinary-private-rss");
  assert.equal(ordinary.status, "failed");
  assert.equal(paths.length, before + 1);
});

test("RSSHub超出4MB或返回非订阅内容时失败，不增加收录也不伪造成功检查", async () => {
  const headers = await auth();
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  const before = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-qwen-blog", headers })).json().rows[0];
  const savedFeed = feed;
  try {
    for (const body of ["x".repeat(4 * 1024 * 1024 + 1), "<html><h1>服务错误</h1></html>"]) {
      feed = body;
      assert.equal((await collectSource("src-qwen-blog")).status, "failed");
      const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-qwen-blog", headers })).json().rows[0];
      assert.equal(card.collectedCount, 1);
      assert.equal(card.lastCheckedAt, before.lastCheckedAt);
    }
  } finally { feed = savedFeed; }
});

test("桥接上限发送给RSSHub，预筛保留AI内容并记录排除数量，不把有限订阅窗口称为完整覆盖", async () => {
  const headers = await auth();
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "limited-bridge", name: "有界桥接", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/limited-bridge/bridge", headers,
    payload: { version: created.json().source.updated_at, name: "有界桥接", route: "/aibase/news", itemLimit: 2, aiFilter: true } })).statusCode, 200);
  const settings = (await app.inject({ url: "/api/admin/studio/news-sources/limited-bridge/bridge", headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/limited-bridge/status", headers,
    payload: { version: settings.version, enabled: true } })).statusCode, 200);
  const previous = feed;
  try {
    feed = '<rss><channel><item><title>AI视频口型更新</title><link>https://film.example/lips</link></item><item><title>今日足球比赛</title><link>https://sport.example/game</link></item></channel></rss>';
    const result = await collectSource("limited-bridge");
    assert.equal(result.status, "ok");
    assert.equal(result.created, 1);
    assert.equal(paths.at(-1), "/aibase/news?limit=2");
    const detail = (await app.inject({ url: "/api/admin/sources/limited-bridge", headers })).json();
    assert.equal(detail.runs[0].detail.received, 2);
    assert.equal(detail.runs[0].detail.filteredByKeyword, 1);
    assert.equal(detail.runs[0].detail.feedWindowOnly, true);
    assert.equal(detail.runs[0].detail.requestedLimit, 2);
  } finally { feed = previous; }
});

test("上游忽略条数上限时整体拒绝，不截断后报告已完整收录", async () => {
  const headers = await auth();
  const previous = feed;
  try {
    feed = '<rss><channel>' + [1, 2, 3].map(index => `<item><title>AI视频${index}</title><link>https://film.example/overflow-${index}</link></item>`).join("") + '</channel></rss>';
    const result = await collectSource("limited-bridge");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /处理上限/);
    const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=limited-bridge", headers })).json().rows[0];
    assert.equal(card.collectedCount, 1);
  } finally { feed = previous; }
});

test("未配置服务、缺路由、暂停或移除来源不能发起桥接HTTP，移除也不能强制绕过", async () => {
  const headers = await auth();
  const before = paths.length;
  delete process.env.STUDIO_RSSHUB_BASE_URL;
  assert.equal((await collectSource("src-qwen-blog")).status, "failed");
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "missing-route-bridge", name: "缺路由", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  assert.equal((await collectSource("missing-route-bridge")).status, "failed");
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=missing-route-bridge", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/missing-route-bridge/status", headers,
    payload: { version: card.version, enabled: false } })).statusCode, 200);
  assert.equal((await collectSource("missing-route-bridge")).error, "paused");
  const paused = (await app.inject({ url: "/api/admin/studio/news-sources?q=missing-route-bridge", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/missing-route-bridge/archive", headers,
    payload: { version: paused.version, archived: true } })).statusCode, 200);
  assert.equal((await collectSource("missing-route-bridge", { force: true })).error, "archived");
  assert.equal(paths.length, before);
});

test("设置读取区分未配置、地址已配置但未验证、配置非法，读取本身不访问RSSHub", async () => {
  const headers = await auth();
  const before = paths.length;
  for (const [address, state] of [[base, "configured"], ["", "not_configured"], ["https://foreign.example", "invalid"]]) {
    process.env.STUDIO_RSSHUB_BASE_URL = address;
    const response = await app.inject({ url: "/api/admin/studio/news-sources/src-qwen-blog/bridge", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().runtimeState, state);
  }
  assert.equal(paths.length, before);
  process.env.STUDIO_RSSHUB_BASE_URL = base;
});

test("到期桥接持久入队去重，关闭采集不排队，任务执行前重新检查暂停", async () => {
  const headers = await auth();
  const studio = SERVER_MODULES.find(module => module.name === "studio")!;
  const schedule = studio.schedules?.find(item => item.name === "studio.rsshub.schedule");
  assert.ok(schedule, "桥接应接入既有worker调度");
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "src-anthropic-news", name: "队列来源", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  process.env.COLLECT_ENABLED = "false";
  assert.deepEqual(await schedule.run(), { queued: 0 });
  process.env.COLLECT_ENABLED = "true";
  process.env.STUDIO_RSSHUB_BASE_URL = base;
  assert.deepEqual(await schedule.run(), { queued: 1 });
  assert.deepEqual(await schedule.run(), { queued: 0 });
  const queue = studio.queues?.find(item => item.name === "studio.rsshub.collect");
  assert.ok(queue);
  const boss = await getBoss();
  const [job] = await boss.fetch<{ sourceId: string }>(queue.name);
  assert.equal(job!.data.sourceId, "src-anthropic-news");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/src-anthropic-news/status", headers,
    payload: { version: created.json().source.updated_at, enabled: false } })).statusCode, 200);
  const before = paths.length;
  await queue.run([job!.data] as never[]);
  await boss.complete(queue.name, job!.id);
  assert.equal(paths.length, before);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-anthropic-news", headers })).json().rows[0];
  assert.equal(card.collectedCount, 0);
  assert.equal(card.lastCheckedAt, null);
});

test("实际导入的启用桥接无需再次启停就能首次调度", async () => {
  const headers = await auth();
  const imported = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/import", headers,
    payload: { sources: [{ id: "src-36kr-newsflash", name: "导入的桥接", kind: "external", config: {}, enabled: true }] } });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().added, 1);
  const studio = SERVER_MODULES.find(module => module.name === "studio")!;
  const schedule = studio.schedules!.find(item => item.name === "studio.rsshub.schedule")!;
  assert.deepEqual(await schedule.run(), { queued: 1 });
  const queue = studio.queues!.find(item => item.name === "studio.rsshub.collect")!;
  const boss = await getBoss();
  const [job] = await boss.fetch<{ sourceId: string }>(queue.name);
  assert.equal(job!.data.sourceId, "src-36kr-newsflash");
  await queue.run([job!.data] as never[]);
  await boss.complete(queue.name, job!.id);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-36kr-newsflash", headers })).json().rows[0];
  assert.equal(card.enabled, true);
  assert.equal(card.collectedCount, 1);
  assert.ok(card.lastCheckedAt);
});

test("桥接首次按已配置上限接收40条背景材料，不能被通用30条默认值静默截断", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "first-window-bridge", name: "首轮背景窗口", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/first-window-bridge/bridge", headers,
    payload: { version: created.json().source.updated_at, name: "首轮背景窗口", route: "/qwen/blog", itemLimit: 50, aiFilter: false } })).statusCode, 200);
  const settings = (await app.inject({ url: "/api/admin/studio/news-sources/first-window-bridge/bridge", headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/first-window-bridge/status", headers,
    payload: { version: settings.version, enabled: true } })).statusCode, 200);
  const previous = feed;
  const date = new Date(Date.now() - 5 * 86400000).toUTCString();
  try {
    feed = '<rss><channel>' + Array.from({ length: 40 }, (_, index) => `<item><title>AI创作背景${index}</title><link>https://background.example/${index}</link><pubDate>${date}</pubDate></item>`).join("") + '</channel></rss>';
    assert.equal((await collectSource("first-window-bridge")).created, 40);
    assert.equal((await collectSource("first-window-bridge")).created, 0);
    const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=first-window-bridge", headers })).json().rows[0];
    assert.equal(card.collectedCount, 40);
  } finally { feed = previous; }
});

test("真实队列串行处理多个桥接任务，不启动网页也能入库", async () => {
  const headers = await auth();
  for (const id of ["src-deepseek-changelog", "src-qbitai-ai"]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name: id, kind: "external", config: {} } })).statusCode, 200);
  }
  const schedule = SERVER_MODULES.find(module => module.name === "studio")!.schedules!.find(item => item.name === "studio.rsshub.schedule")!;
  assert.deepEqual(await schedule.run(), { queued: 2 });
  peak = 0; responseDelay = 200;
  const boss = await getBoss();
  // Exercise the real admission policy with only OS counters/time accelerated; preserve the
  // existing real HTTP/DB/concurrency assertions rather than waiting a minute in every test.
  let clock = 0;
  const monitor = createHostResourceMonitor({ now: () => clock, read: () => {
    clock += 5000;
    return { availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3, cpus: [{ idle: clock, total: clock * 2 }] };
  } });
  const queue = createBridgeQueue(monitor);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  await workModuleQueues(boss);
  for (let n = 0; n < 13; n++) monitor.sample();
  try {
    let complete = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rows = (await app.inject({ url: "/api/admin/studio/news-sources?limit=100", headers })).json().rows;
      complete = ["src-deepseek-changelog", "src-qbitai-ai"].every(id => rows.find((row: { id: string; collectedCount: number }) => row.id === id)?.collectedCount === 1);
      if (complete) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(complete, true, "后台worker应完成两项实际入库");
    assert.equal(peak, 1, "慢HTTP源的实际请求必须串行");
  } finally { responseDelay = 0; }
});
