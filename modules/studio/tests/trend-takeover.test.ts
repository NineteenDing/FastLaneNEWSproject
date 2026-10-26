import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
const previousBase = process.env.STUDIO_RSSHUB_BASE_URL;
process.env.STUDIO_RSSHUB_BASE_URL = "http://127.0.0.1:12345";
after(async () => {
  if (previousBase === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = previousBase;
  await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close();
});

test("旧RSSHub请求在途时不能接管知乎热榜，接管后旧队列及强制新闻采集不改变健康或正文", async () => {
  const id = "src-zhihu-hot", boards = "/api/admin/studio/trends/boards";
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id, name: "知乎原热榜", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  let reached!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  transport.get("http://127.0.0.1:12345").intercept({ path: "/zhihu/hot?limit=15" }).reply(() => {
    reached(); return { statusCode: 200, data: '<rss><channel><item><title>AI视频旧榜单</title><link>https://www.zhihu.com/question/111</link></item></channel></rss>' };
  }).delay(150);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.rsshub.collect")!;
  const work = queue.run([{ sourceId: id }] as never[]);
  await requested;
  try {
    const rejected = await app.inject({ method: "POST", url: boards + "/zhihu", headers,
      payload: { sourceVersion: created.json().source.updated_at } });
    assert.equal(rejected.statusCode, 409, "在途旧请求提交完之前不允许切换采集归属");
    assert.equal((await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "zhihu").connected, false);
  } finally { await work; }
  const source = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  const joined = await app.inject({ method: "POST", url: boards + "/zhihu", headers, payload: { sourceVersion: source.version } });
  assert.equal(joined.statusCode, 200);
  const before = (await app.inject({ url: "/api/admin/sources/" + id, headers })).json();
  await queue.run([{ sourceId: id }] as never[]);
  assert.equal((await collectSource(id, { force: true })).status, "skipped", "强制旧采集也不能重新取得已接管来源");
  assert.deepEqual((await app.inject({ url: "/api/admin/sources/" + id, headers })).json(), before);
  transport.assertNoPendingInterceptors();
});
