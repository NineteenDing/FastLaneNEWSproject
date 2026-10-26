import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { douyinVideoDetailFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouVideoDetailFixture, kuaishouCookie } from "./kuaishou-fixture.ts";
import { tiebaFixture } from "./tieba-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const provider = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  return { choices: [{ message: { content: JSON.stringify({ decision: "relevant", reason: "与角色制作有关，需取得原文", titleQuote: input.signal.title, viewerProblem: "角色一致性制作方法" }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-representative", LLM_MODEL: "isolated-quality" });
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
const module = SERVER_MODULES.find(module => module.name === "studio")!;
async function run(name: string) {
  const queue = module.queues!.find(queue => queue.name === name)!;
  const boss = await getBoss(), [job] = await boss.fetch(name); assert.ok(job);
  try { await queue.run([job.data] as never[]); }
  catch (cause) { throw new Error(`任务未完成，尚未请求的外部替身：${transport.pendingInterceptors().map(row => row.path).join(", ")}`, { cause }); }
  await boss.complete(name, job.id);
}

test("微博热榜话题经原客户端有界搜索取得一条代表原文，独立计额且不自动关注作者", async () => {
  config.modelCallsEnabled = true;
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers, payload: { version: 0, cookie: "SUB=isolated-representative" } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/weibo", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "weibo");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  transport.get("https://s.weibo.com").intercept({ path: "/top/summary?cate=realtimehot" }).reply(200,
    '<div id="pl_top_realtimehot"><table><tbody><tr><td class="td-01">1</td><td class="td-02"><a href="/weibo?q=%23AI角色控制%23">AI角色控制</a><span>12000</span></td></tr></tbody></table></div>');
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/weibo/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queuedCount, 1);
  const id = "5300000000000011";
  transport.get("https://m.weibo.cn").intercept({ path: value => {
    const url = new URL(value, "https://m.weibo.cn");
    return url.pathname === "/api/container/getIndex" && url.searchParams.get("containerid") === "100103type=1&q=AI角色控制" && url.searchParams.get("page") === "1";
  } }).reply(200, { ok: 1, data: { cards: [{ card_type: 11, card_group: [{ card_type: 9, mblog: { id } }] }] } });
  const item = { id, text: "<p>角色参考需锁定，再逐镜检查人物差异。</p>", user: { id: "5756404150", screen_name: "角色制作手记" }, attitudes_count: 120 };
  transport.get("https://m.weibo.cn").intercept({ path: `/detail/${id}` }).reply(200, `<script>var $render_data = ${JSON.stringify([{ status: item }])}[0]</script>`);
  await run("studio.content.import");
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows[0];
  assert.equal(signal.deepRead.state, "ready");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.url, `https://m.weibo.cn/detail/${id}`); assert.equal(material.body, "角色参考需锁定，再逐镜检查人物差异。");
  assert.equal(material.trends[0].method, "search_representative"); assert.equal(material.trends[0].title, "AI角色控制");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/trends/deep-read-settings", headers })).json().usedToday, 1);
  transport.assertNoPendingInterceptors();
});

test("话题搜索无结果不伪造原文，显式重试复用额度和已有作品且不改写旧正文", async () => {
  transport.get("https://s.weibo.com").intercept({ path: "/top/summary?cate=realtimehot" }).reply(200,
    '<div id="pl_top_realtimehot"><table><tbody><tr><td class="td-01">1</td><td class="td-02"><a href="/weibo?q=AI角色镜头衔接">AI角色镜头衔接</a></td></tr></tbody></table></div>');
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/weibo/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  const search = () => transport.get("https://m.weibo.cn").intercept({ path: value => new URL(value, "https://m.weibo.cn").searchParams.get("containerid") === "100103type=1&q=AI角色镜头衔接" });
  search().reply(200, { ok: 1, data: { cards: [] } });
  const boss = await getBoss(), queue = module.queues!.find(queue => queue.name === "studio.content.import")!, [job] = await boss.fetch(queue.name); assert.ok(job);
  await assert.rejects(queue.run([job.data] as never[]), /未完成导入/); await boss.fail(queue.name, job.id);
  let signal = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { title: string }) => row.title === "AI角色镜头衔接");
  assert.equal(signal.deepRead.state, "failed"); assert.equal(signal.deepRead.materialId, null);
  assert.equal(signal.deepRead.errorCode, "no_representative", "单页搜索无候选须与平台故障区分");
  const imports = (await app.inject({ url: "/api/admin/studio/content-imports", headers })).json().rows;
  assert.equal(imports.find((item: { errorCode: string }) => item.errorCode === "no_representative").retryVia, "trend_deep_read");
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?origin=trends", headers })).json().total, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: { retryFailed: true } })).json().queuedCount, 1);
  search().reply(200, { ok: 1, data: { cards: [{ card_type: 9, mblog: { id: "5300000000000011" } }] } });
  transport.get("https://m.weibo.cn").intercept({ path: "/detail/5300000000000011" }).reply(200,
    '<script>var $render_data = [{"status":{"id":"5300000000000011","text":"后续修改的正文","user":{"id":"5756404150"}}}][0]</script>');
  await run("studio.content.import");
  signal = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { title: string }) => row.title === "AI角色镜头衔接");
  assert.equal(signal.deepRead.state, "ready");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.body, "角色参考需锁定，再逐镜检查人物差异。"); assert.equal(material.trends.length, 2);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?origin=trends", headers })).json().total, 1);
  assert.equal((await app.inject({ url: "/api/admin/studio/trends/deep-read-settings", headers })).json().usedToday, 2);
  transport.assertNoPendingInterceptors();
});

test("抖音热榜话题复用原客户端搜索和签名详情读取，不把热榜标题当作视频正文", async () => {
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/douyin", headers, payload: { version: 0, cookie: douyinCookie } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/douyin", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "douyin");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  transport.get("https://login.douyin.com").intercept({ path: "/" }).reply(200, "bootstrap");
  transport.get("https://www.douyin.com").intercept({ path: /^\/aweme\/v1\/web\/hot\/search\/list\// }).reply(200, { status_code: 0, data: { word_list: [{ sentence_id: "12345", word: "AI视频角色一致性", hot_value: 30000 }] } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/douyin/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  transport.get("https://www.douyin.com").intercept({ path: value => {
    const url = new URL(value, "https://www.douyin.com");
    return url.pathname === "/aweme/v1/web/general/search/single/" && url.searchParams.get("keyword") === "AI视频角色一致性"
      && url.searchParams.get("offset") === "0" && url.searchParams.get("count") === "15" && url.searchParams.get("msToken") === "private-douyin-ms-token";
  } }).reply(200, { status_code: 0, data: [{ aweme_info: { aweme_id: "7600000000000000001" } }] });
  douyinVideoDetailFixture(transport);
  await run("studio.content.import");
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=douyin", headers })).json().rows[0];
  assert.equal(signal.deepRead.state, "awaiting_transcript");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.body, "先固定角色，再做不同镜头。"); assert.equal(material.bodyState, "not_transcribed");
  assert.equal(material.trends[0].method, "search_representative");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  transport.assertNoPendingInterceptors();
});

test("快手热榜用原页面SDK签名单页搜索取得代表作品，搜索与详情请求严格分开", async () => {
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/kuaishou", headers, payload: { version: 0, cookie: kuaishouCookie } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/kuaishou", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "kuaishou");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  const apollo = { defaultClient: { ROOT_QUERY: { 'visionHotRank({"page":"home"})': { id: "rank" } }, rank: { result: 1, items: [{ id: "VisionHotRankItem:AI" }] }, "VisionHotRankItem:AI": { name: "AI分镜制作", tagType: "热点" } } };
  transport.get("https://www.kuaishou.com").intercept({ path: "/?isHome=1" }).reply(200, `<script>window.__APOLLO_STATE__ = ${JSON.stringify(apollo)};</script>`);
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/kuaishou/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  kuaishouVideoDetailFixture(transport, { searchTerm: "AI分镜制作" });
  transport.get("https://www.kuaishou.com").intercept({ path: "/rest/v/search/feed?__NS_hxfalcon=fixture-search-signature&caver=2", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8"));
    return body.keyword === "AI分镜制作" && body.pcursor === "" && body.page === "search" && body.searchSessionId === "";
  } }).reply(200, { result: 1, feeds: [{ type: "video", photo: { id: "3xfilmvideo" } }] });
  await run("studio.content.import");
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=kuaishou", headers })).json().rows[0];
  assert.equal(signal.deepRead.state, "awaiting_transcript");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.body, "固定角色，再安排近景与远景。"); assert.equal(material.trends[0].method, "search_representative");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  transport.assertNoPendingInterceptors();
});

test("知乎热榜问题经原客户端搜索再读具体回答，搜索摘要不充当完整事实材料", async () => {
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/zhihu", headers, payload: { version: 0, cookie: "d_c0=private-search-device; z_c0=private-search-login" } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/zhihu", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "zhihu");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  const api = transport.get("https://www.zhihu.com");
  api.intercept({ path: "/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true" }).reply(200, { data: [{ target: { title_area: { text: "AI角色一致性如何解决" }, link: { url: "https://www.zhihu.com/question/77001" } } }] });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/zhihu/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  const signed = { "x-zse-96": /^2\.0_/, "x-zst-81": /^3_2\.0/, cookie: "d_c0=private-search-device; z_c0=private-search-login" };
  api.intercept({ path: value => {
    const url = new URL(value, "https://www.zhihu.com");
    return url.pathname === "/api/v4/search_v3" && url.searchParams.get("q") === "AI角色一致性如何解决" && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "15";
  }, headers: signed }).reply(200, { data: [{ type: "search_result", object: { id: 88001, type: "answer", question: { id: 77001 }, content: "搜索摘要", created_time: 1792231200, updated_time: 1792231200, author: { id: "search-author", name: "回答作者", url_token: "film-research" } } }] });
  const entities = { users: { "search-author": { id: "search-author", urlToken: "film-research", name: "回答作者" } }, questions: { "77001": { id: 77001, title: "AI角色一致性如何解决" } },
    answers: { "88001": { id: 88001, type: "answer", author: "search-author", question: "77001", content: "<p>实际完整回答：先固定参考，再检查连续镜头。</p>", commentCount: 0 } } };
  api.intercept({ path: "/question/77001/answer/88001", headers: signed }).reply(200, `<script id="js-initialData">${JSON.stringify({ initialState: { entities } })}</script>`);
  await run("studio.content.import");
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=zhihu", headers })).json().rows[0];
  assert.equal(signal.deepRead.state, "ready");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.body, "实际完整回答：先固定参考，再检查连续镜头。"); assert.equal(material.trends[0].method, "search_representative");
  assert.equal(material.parent.url, "https://www.zhihu.com/question/77001");
  transport.assertNoPendingInterceptors();
});

test("贴吧热榜话题复用原PC搜索及指定帖子详情，保留首楼和真实回帖层级", async () => {
  const settings = (await app.inject({ url: "/api/admin/studio/trends/deep-read-settings", headers })).json();
  await app.inject({ method: "PUT", url: "/api/admin/studio/trends/deep-read-settings", headers, payload: { version: settings.version, enabled: true, dailyLimit: 10 } });
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/tieba", headers, payload: { version: 0, cookie: "BDUSS=private-tieba-cookie" } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/tieba", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "tieba");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  const api = transport.get("https://tieba.baidu.com");
  api.intercept({ path: "/hottopic/browse/topicList" }).reply(200, { data: { bang_topic: { topic_list: [{ topic_id: "900", topic_name: "AI镜头制作方法", topic_url: "https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=900" }] } } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/tieba/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  tiebaFixture(transport, { single: true });
  api.intercept({ path: value => {
    const url = new URL(value, "https://tieba.baidu.com");
    return url.pathname === "/mo/q/search/multsearch" && url.searchParams.get("word") === "AI镜头制作方法"
      && url.searchParams.get("pn") === "1" && url.searchParams.get("rn") === "20" && /^[0-9a-f]{32}$/.test(url.searchParams.get("sign") ?? "");
  } }).reply(200, { error_code: 0, data: { card_list: [{ cardInfo: "thread", data: { tid: "99001", title: "搜索摘要", content: "搜索片段", time: 1792231200 } }] } });
  await run("studio.content.import");
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=tieba", headers })).json().rows[0];
  assert.equal(signal.deepRead.state, "ready");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${signal.deepRead.materialId}`, headers })).json();
  assert.equal(material.body, "先锁定角色参考，再切换不同景别。"); assert.equal(material.comments[0].floor, 2);
  assert.equal(material.trends[0].method, "search_representative");
  transport.assertNoPendingInterceptors();
});

test("话题搜索期间暂停来源，迟到的登录错误按中断处理，恢复不要求人工重试失败", async () => {
  transport.get("https://s.weibo.com").intercept({ path: "/top/summary?cate=realtimehot" }).reply(200,
    '<div id="pl_top_realtimehot"><table><tbody><tr><td class="td-01">1</td><td class="td-02"><a href="/weibo?q=AI场景连续性">AI场景连续性</a></td></tr></tbody></table></div>');
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/weibo/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  const requested = Promise.withResolvers<void>();
  transport.get("https://m.weibo.cn").intercept({ path: value => new URL(value, "https://m.weibo.cn").searchParams.get("containerid") === "100103type=1&q=AI场景连续性" })
    .reply(() => { requested.resolve(); return { statusCode: 403, data: "login required" }; }).delay(100);
  const boss = await getBoss(), queue = module.queues!.find(queue => queue.name === "studio.content.import")!, [job] = await boss.fetch(queue.name); assert.ok(job);
  const work = queue.run([job.data] as never[]).then(() => null, error => error as Error);
  await requested.promise;
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "weibo");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: false } });
  const error = await work; if (error) await boss.fail(queue.name, job.id); else await boss.complete(queue.name, job.id);
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=weibo", headers })).json().rows.find((row: { title: string }) => row.title === "AI场景连续性");
  assert.equal(signal.deepRead.state, "interrupted"); assert.equal(signal.deepRead.errorCode, null); assert.equal(error, null);
  const paused = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "weibo");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: paused.source.version, enabled: true } });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: {} })).json().queuedCount, 1);
  transport.assertNoPendingInterceptors();
});
