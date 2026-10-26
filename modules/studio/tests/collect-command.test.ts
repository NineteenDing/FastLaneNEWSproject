import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { bridgeQueue } from "../backend/rsshub-jobs.ts";

installModules(SERVER_MODULES);
after(async () => { await stopBoss(); await closeDb(); });

async function commandApp() {
  const app = await buildApp();
  config.adminPassword = "collect-command-test-password";
  config.allowPrivateNetworkFetch = true;
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=collect-command-test-password" });
    assert.equal(login.statusCode, 303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
    return { app, headers: { cookie, "x-csrf-token": me.json().csrf as string } };
  } catch (error) { await app.close(); throw error; }
}

const collect = (ids: string[], env: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, ["scripts/collect.ts", ...ids], {
  env: { ...process.env, COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "false", ALLOW_PRIVATE_NETWORK_FETCH: "true", ...env }, timeout: 15_000,
});
const commandRows = (output: string) => output.split(/\r?\n/)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(row => row?.sourceId);

test("采集命令遇到不存在的来源以非零状态返回，不伪装为已提交", async () => {
  await assert.rejects(collect(["missing-command-source"]), (error: Error & { code?: number; stdout?: string }) => {
    assert.equal(error.code, 1);
    assert.ok(error.stdout?.includes('"state":"not_found"'));
    assert.ok(!error.stdout?.includes('"state":"submitted"'));
    return true;
  });
});

test("采集命令仅提交原持久任务，重复提交不重复排队或直接抓取", async () => {
  let requests = 0;
  const upstream = createServer((_req, res) => {
    requests++;
    res.end('<rss><channel><item><title>仅排队的新闻</title><link>https://news.example/command</link><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>');
  });
  const url = await listenHttpForFetch(upstream);
  const { app, headers } = await commandApp();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "command-rss", name: "命令采集来源", kind: "rss", participation_mode: "isolated", config: { feedUrl: url } } })).statusCode, 200);
    const first = await collect(["command-rss"]);
    assert.equal(requests, 0, "命令必须通过后台队列领取，不能直接访问上游");
    const submitted = commandRows(first.stdout).find(row => row.sourceId === "command-rss");
    assert.equal(submitted.state, "submitted");
    assert.equal(typeof submitted.jobId, "string");
    await collect(["command-rss"]);
    const boss = await getBoss();
    const jobs = await boss.findJobs<{ sourceId: string; force: boolean }>(QUEUES.fetchSource, { key: "manual:command-rss" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, submitted.jobId);
    assert.equal(jobs[0]!.state, "created");
    assert.equal(jobs[0]!.data.force, true);
    assert.equal(jobs[0]!.retryCount, 0);
    assert.equal(requests, 0);
    const detail = (await app.inject({ url: "/api/admin/sources/command-rss", headers })).json();
    assert.equal(detail.runs.length, 0);
    assert.equal(detail.items.length, 0);
    assert.equal(detail.source.health, "unknown");
  } finally {
    await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("一批命令拒绝已移除和缺规则来源仍提交其余来源，错误不输出内部异常", async () => {
  let requests = 0;
  const upstream = createServer((_req, res) => { requests++; res.end('<html><a href="/about">关于我们</a></html>'); });
  const url = await listenHttpForFetch(upstream);
  const { app, headers } = await commandApp();
  try {
    const removed = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "removed-command", name: "移除来源", kind: "rss", config: { feedUrl: "https://news.example/removed?token=source-private" } } });
    assert.equal(removed.statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/removed-command/archive", headers,
      payload: { version: removed.json().source.updated_at, archived: true } })).statusCode, 200);
    const unready = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
      payload: { name: "缺提取规则", kind: "web_list", url } });
    assert.equal(unready.statusCode, 200);
    const unreadyId = unready.json().id as string;
    assert.equal(requests, 1, "新增时有界试读不等于已配好提取规则");
    requests = 0;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "valid-command", name: "仍可排队", kind: "rss", config: { feedUrl: "https://news.example/feed" } } })).statusCode, 200);
    await assert.rejects(collect(["removed-command", unreadyId, "valid-command"]),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      const rows = commandRows(error.stdout ?? "");
      assert.deepEqual(rows.map(row => [row.sourceId, row.state]), [
        ["removed-command", "failed"], [unreadyId, "failed"], ["valid-command", "submitted"],
      ]);
      assert.ok(rows.slice(0, 2).every(row => row.code === "COLLECTION_SUBMIT_FAILED"));
      assert.ok(!`${error.stdout}${error.stderr}`.includes("source-private"));
      assert.ok(!`${error.stdout}${error.stderr}`.includes("file:///"));
      return true;
    });
    const boss = await getBoss();
    assert.equal((await boss.findJobs(QUEUES.fetchSource, { key: "manual:removed-command" })).length, 0);
    assert.equal((await boss.findJobs(QUEUES.fetchSource, { key: `manual:${unreadyId}` })).length, 0);
    assert.equal((await boss.findJobs(QUEUES.fetchSource, { key: "manual:valid-command" }))[0]!.state, "created");
    assert.equal(requests, 0);
  } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("采集命令安装站点模块，将RSSHub来源交给专属受控队列而非直接读取", async () => {
  let requests = 0;
  const upstream = createServer((_req, res) => { requests++; res.end('<rss><channel/></rss>'); });
  const url = await listenHttpForFetch(upstream);
  const { app, headers } = await commandApp();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "src-qwen-blog", name: "千问桥接", kind: "external", config: {} } })).statusCode, 200);
    const result = await collect(["src-qwen-blog"], {
      STUDIO_RSSHUB_BASE_URL: url, STUDIO_RSSHUB_NATIVE_DIRECTORY: "",
    });
    assert.ok(result.stdout.includes('"state":"submitted"'));
    assert.equal(requests, 0);
    const boss = await getBoss();
    assert.equal((await boss.findJobs(QUEUES.fetchSource, { key: "manual:src-qwen-blog" })).length, 0);
    const jobs = await boss.findJobs<{ sourceId: string }>(bridgeQueue.name, { key: "src-qwen-blog" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, "created");
    assert.equal(jobs[0]!.data.sourceId, "src-qwen-blog");
  } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
