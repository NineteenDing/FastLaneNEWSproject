import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { collectSource } from "@aihot/backend/sources/collect";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
const folder = await mkdtemp(path.resolve(".local/native-rsshub-collection-test-"));
await mkdir(path.join(folder, "dist"));
const manifestFile = folder + "-approved.json";
const previous = { directory: process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY, base: process.env.STUDIO_RSSHUB_BASE_URL, manifest: process.env.STUDIO_RSSHUB_BUILD_MANIFEST };
after(async () => {
  for (const [key, value] of [["STUDIO_RSSHUB_NATIVE_DIRECTORY", previous.directory], ["STUDIO_RSSHUB_BASE_URL", previous.base], ["STUDIO_RSSHUB_BUILD_MANIFEST", previous.manifest]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  await app.close(); await stopBoss(); await closeDb();
  assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
  await rm(folder, { recursive: true, force: true });
  await rm(manifestFile, { force: true });
});

test("原生RSSHub接入原采集流程：来源身份和RSS解析复用、去重、状态可查", async () => {
  const feed = `<rss version="2.0"><channel><title>外部应用替身</title><item><title>AI影视制作原生采集接口</title>
    <link>https://publisher.example/native-collection</link><pubDate>${new Date().toUTCString()}</pubDate>
    <description>素材来源有记录</description></item></channel></rss>`;
  // This is an approved external fixture release, not a snapshot of real RSSHub or a verifier assertion.
  const releaseFiles: Record<string, string> = { "package.json": '{"type":"module"}', "pnpm-lock.yaml": "fixture lock",
    "LICENSE": "fixture license", "README.md": "fixture application",
    "dist/index.mjs": `export default {fetch:()=>new Response(${JSON.stringify(feed)},{headers:{'content-type':'application/rss+xml'}})};` };
  await mkdir(path.join(folder, "public")); await mkdir(path.join(folder, "patches"));
  const digest = createHash("sha256"); let bytes = 0;
  for (const name of Object.keys(releaseFiles).sort()) {
    await writeFile(path.join(folder, name), releaseFiles[name]);
    bytes += Buffer.byteLength(releaseFiles[name]);
    digest.update(name + "\0" + createHash("sha256").update(releaseFiles[name]).digest("hex") + "\n");
  }
  await writeFile(manifestFile, JSON.stringify({ schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6",
    files: Object.keys(releaseFiles).length, bytes, sha256: digest.digest("hex") }));
  process.env.STUDIO_RSSHUB_BUILD_MANIFEST = manifestFile;
  process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY = folder;
  delete process.env.STUDIO_RSSHUB_BASE_URL;
  config.allowPrivateNetworkFetch = false;
  config.adminPassword = "native-collection-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=native-collection-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  const headers = { cookie, "x-csrf-token": me.json().csrf as string };
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "src-qwen-blog", name: "原生采集接口测试", kind: "external", config: {} } })).statusCode, 200);
  const settings = (await app.inject({ url: "/api/admin/studio/news-sources/src-qwen-blog/bridge", headers })).json();
  assert.equal(settings.runtimeState, "configured");
  const first = await collectSource("src-qwen-blog");
  assert.equal(first.status, "ok");
  assert.equal(first.created, 1);
  assert.equal((await collectSource("src-qwen-blog")).created, 0);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-qwen-blog", headers })).json().rows[0];
  assert.equal(card.collectedCount, 1);
  assert.ok(card.lastCheckedAt);
  const detail = (await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json();
  assert.equal(detail.items[0].title, "AI影视制作原生采集接口");
  assert.equal(detail.runs[0].detail.feedWindowOnly, true);
  assert.equal(config.allowPrivateNetworkFetch, false);
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>new Response(${JSON.stringify(feed)})}; // changed build`);
  const changed = await collectSource("src-qwen-blog");
  assert.equal(changed.status, "failed", "原生采集必须校验固定构建，不能加载修改后的程序");
  const unchanged = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-qwen-blog", headers })).json().rows[0];
  assert.equal(unchanged.collectedCount, 1);
  assert.equal(unchanged.lastCheckedAt, card.lastCheckedAt);
});
