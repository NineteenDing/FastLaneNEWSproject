import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("平台热榜须登录，显式接入默认暂停并保留唯一来源，小红书未适配不假称支持", async () => {
  const path = "/api/admin/studio/trends/boards";
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const catalog = await app.inject({ url: path, headers });
  assert.equal(catalog.statusCode, 200); assert.equal(catalog.headers["cache-control"], "no-store");
  assert.equal(catalog.json().rows.length, 8);
  assert.equal(catalog.json().rows.filter((board: { supported: boolean }) => board.supported).length, 7);
  assert.equal(catalog.json().rows.find((board: { platform: string }) => board.platform === "xhs").supported, false);
  const added = await app.inject({ method: "POST", url: path + "/bilibili", headers, payload: {} });
  assert.equal(added.statusCode, 200); assert.equal(added.json().created, true);
  const row = (await app.inject({ url: path, headers })).json().rows.find((board: { platform: string }) => board.platform === "bilibili");
  assert.equal(row.source.id, added.json().sourceId); assert.equal(row.source.enabled, false);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources", headers })).json().rows[0];
  assert.equal(card.id, added.json().sourceId); assert.equal(card.kind, "external");
  assert.equal(card.enabled, false); assert.ok(card.tags.includes("平台热榜"));
  const repeat = await app.inject({ method: "POST", url: path + "/bilibili", headers, payload: {} });
  assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().created, false); assert.equal(repeat.json().sourceId, added.json().sourceId);
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources", headers })).json().total, 1);
  assert.equal((await app.inject({ method: "POST", url: path + "/xhs", headers, payload: {} })).statusCode, 409);
});

test("百度榜单可一次启用，复用原队列保存实际排名热度，当前榜单不混入已离榜条目", async () => {
  process.env.COLLECT_ENABLED = "true";
  const path = "/api/admin/studio/trends/boards", submitted = await app.inject({ method: "POST", url: path + "/baidu", headers, payload: { enabled: true } });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const board = (await app.inject({ url: path, headers })).json().rows.find((row: { platform: string }) => row.platform === "baidu");
  assert.equal(board.source.enabled, true);
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?excludeTrends=true", headers })).json().rows.some((row: { id: string }) => row.id === board.source.id), false);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!, boss = await getBoss();
  for (const includeOld of [true, false]) {
    const content = [{ word: "置顶内容", rawUrl: "https://www.baidu.com/s?wd=pinned", isTop: true },
      { word: "AI影视新工具", rawUrl: "https://www.baidu.com/s?wd=film", hotScore: "12345" },
      ...(includeOld ? [{ word: "旧热搜", rawUrl: "https://www.baidu.com/s?wd=old" }] : [])];
    transport.get("https://top.baidu.com").intercept({ path: "/board?tab=realtime", headers: headers => !headers.cookie })
      .reply(200, `<!doctype html><!--s-data:${JSON.stringify({ data: { cards: [{ content }] } })}-->`);
    assert.equal((await app.inject({ method: "POST", url: path + "/baidu/check", headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  }
  const current = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=baidu&current=true", headers })).json();
  assert.equal(current.total, 1); assert.equal(current.rows[0].title, "AI影视新工具");
  assert.equal(current.rows[0].observations.at(-1).rank, 1); assert.equal(current.rows[0].observations.at(-1).rawHeat, "12345");
  assert.equal(current.rows[0].observations.at(-1).metrics.views, null);
  assert.equal((await app.inject({ url: "/api/admin/studio/trends/signals?platform=baidu", headers })).json().total, 2, "离榜记录仍保留历史");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  const latest = (await app.inject({ url: path, headers })).json().rows.find((row: { platform: string }) => row.platform === "baidu");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${latest.source.id}/status`, headers,
    payload: { version: latest.source.version, enabled: false } })).statusCode, 200);
  transport.assertNoPendingInterceptors();
});

test("检查热榜经持久任务保存实际排行观察，重复条目不变成多条新闻，播放量不冒充榜单热度", async () => {
  const boards = "/api/admin/studio/trends/boards", signals = "/api/admin/studio/trends/signals?platform=bilibili";
  const board = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
    payload: { version: board.source.version, enabled: true } })).statusCode, 200);
  const sample = (order: boolean) => ({ code: 0, data: { list: (order ? [1, 2] : [2, 1]).map(index => ({ bvid: `BV1${index}411c7mD8`,
    title: index === 1 ? "AI视频角色一致性方法" : "足球赛回顾", pubdate: 1720000000,
    owner: { mid: index, name: "隔离作者" }, desc: "榜单简介不是视频全文。", stat: { view: 0, like: 7, reply: 3 } })) } });
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues?.find(queue => queue.name === "studio.trends.collect");
  for (const order of [true, false]) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, sample(order));
    const submitted = await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} });
    assert.equal(submitted.statusCode, 200);
    assert.ok(queue); const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  }
  assert.equal((await app.inject({ url: signals })).statusCode, 401);
  const saved = await app.inject({ url: signals, headers });
  assert.equal(saved.statusCode, 200); assert.equal(saved.headers["cache-control"], "no-store");
  assert.equal(saved.json().total, 2);
  const item = saved.json().rows.find((row: { title: string }) => row.title === "AI视频角色一致性方法");
  assert.equal(item.url, "https://www.bilibili.com/video/BV11411c7mD8");
  assert.equal(item.disposition, "pending_relevance"); assert.equal(item.observations.length, 2);
  assert.deepEqual(item.observations.map((observation: { rank: number }) => observation.rank), [1, 2]);
  assert.equal(item.observations[0].rawHeat, null); assert.equal(item.observations[0].metrics.views, 0);
  assert.ok(item.observations[0].observedAt); assert.ok(item.firstSeenAt);
  const ready = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal(ready.collection.state, "ready"); assert.equal(ready.collection.itemCount, 2); assert.ok(ready.collection.checkedAt);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().total, 0, "热搜标题不是已核实新闻正文");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0, "不自动关注榜单作者");
  transport.assertNoPendingInterceptors();
});

test("沿用原知乎热榜身份且版本冲突受保护，只由热榜任务调度，暂停后的旧任务不走RSSHub", async t => {
  const path = "/api/admin/studio/trends/boards", created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "src-zhihu-hot", name: "原有知乎热榜", kind: "external", config: {}, tags: ["原分组"] } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: path + "/zhihu", headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: path + "/zhihu", headers, payload: { sourceVersion: "2000-01-01T00:00:00.000Z" } })).statusCode, 409);
  const joined = await app.inject({ method: "POST", url: path + "/zhihu", headers, payload: { sourceVersion: created.json().source.updated_at } });
  assert.equal(joined.statusCode, 200); assert.equal(joined.json().sourceId, "src-zhihu-hot");
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=src-zhihu-hot", headers })).json().rows[0];
  assert.equal(card.name, "原有知乎热榜"); assert.deepEqual(card.tags, ["原分组", "平台热榜"]); assert.equal(card.enabled, false);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/src-zhihu-hot/status", headers, payload: { version: card.version, enabled: true } })).statusCode, 200);
  const submit = await app.inject({ method: "POST", url: "/api/admin/sources/src-zhihu-hot/fetch", headers });
  assert.equal(submit.statusCode, 200);
  const module = SERVER_MODULES.find(module => module.name === "studio")!, schedule = module.schedules!.find(schedule => schedule.name === "studio.trends.schedule");
  assert.ok(schedule);
  const previousBase = process.env.STUDIO_RSSHUB_BASE_URL; process.env.STUDIO_RSSHUB_BASE_URL = "http://127.0.0.1:12345";
  t.after(() => { if (previousBase === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = previousBase; });
  assert.deepEqual(await module.schedules!.find(schedule => schedule.name === "studio.rsshub.schedule")!.run(), { queued: 0 });
  assert.deepEqual(await schedule.run(), { queued: 0 });
  const queue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  transport.get("https://www.zhihu.com").intercept({ path: "/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true" })
    .reply(200, { data: [{ target: { title_area: { text: "AI镜头控制" }, link: { url: "https://www.zhihu.com/question/999" } } }] });
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  assert.deepEqual(await schedule.run(), { queued: 0 }, "成功后约30分钟再检查");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.now() + 31 * 60000) });
  assert.deepEqual(await schedule.run(), { queued: 2 }, "已启用的B站和知乎均到期"); assert.deepEqual(await schedule.run(), { queued: 0 });
  const late = await boss.fetch(queue.name, { batchSize: 2 }); assert.equal(late.length, 2);
  const current = (await app.inject({ url: path, headers })).json().rows.filter((board: { platform: string }) => ["zhihu", "bilibili"].includes(board.platform));
  for (const board of current) assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
    payload: { version: board.source.version, enabled: false } })).statusCode, 200);
  for (const job of late) { await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); }
  const signals = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=zhihu", headers })).json();
  assert.equal(signals.total, 1); assert.equal(signals.rows[0].observations.length, 1);
});

test("六个平台沿固定榜单解析保存原始热度与缺值，不把搜索榜单当成作者作品或复制上游Cookie", async () => {
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!;
  const samples = [
    { platform: "douyin", origin: "https://www.douyin.com", path: "/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1",
      body: { status_code: 0, data: { word_list: [{ sentence_id: "12345", word: "AI漫剧制作方法", hot_value: "1234567" }] } }, title: "AI漫剧制作方法", heat: "1234567" },
    { platform: "weibo", origin: "https://s.weibo.com", path: "/top/summary?cate=realtimehot",
      body: '<div id="pl_top_realtimehot"><table><tbody><tr><td>置顶</td></tr><tr><td class="td-01">1</td><td class="td-02"><a href="/weibo?q=AIvideo">AI视频模型更新</a><span>234567</span></td></tr></tbody></table></div>', title: "AI视频模型更新", heat: "234567" },
    { platform: "zhihu", origin: "https://www.zhihu.com", path: "/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true",
      body: { data: [{ target: { title_area: { text: "AI影视如何提高效率" }, link: { url: "https://www.zhihu.com/question/123456" }, metrics_area: { text: "87万热度" } } }] }, title: "AI影视如何提高效率", heat: "87万热度" },
    { platform: "tieba", origin: "https://tieba.baidu.com", path: "/hottopic/browse/topicList",
      body: { data: { bang_topic: { topic_list: [{ topic_id: "111", topic_name: "AI配音工作流", topic_url: "https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=111" }] } } }, title: "AI配音工作流", heat: null },
    { platform: "kuaishou", origin: "https://www.kuaishou.com", path: "/?isHome=1",
      body: '<script>window.__APOLLO_STATE__ = {"defaultClient":{"ROOT_QUERY":{"visionHotRank({\\"page\\":\\"home\\"})":{"id":"rank"}},"rank":{"result":1,"items":[{"id":"VisionHotRankItem:AI"}]},"VisionHotRankItem:AI":{"name":"AI分镜制作","tagType":"热点"}}};</script>', title: "AI分镜制作", heat: null },
  ];
  for (const sample of samples) {
    const connected = await app.inject({ method: "POST", url: `/api/admin/studio/trends/boards/${sample.platform}`, headers, payload: {} });
    assert.equal(connected.statusCode, 200);
    const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === sample.platform);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
      payload: { version: board.source.version, enabled: true } })).statusCode, 200);
    if (sample.platform === "douyin") transport.get("https://login.douyin.com").intercept({ path: "/" }).reply(200, "", { headers: { "set-cookie": "passport_csrf_token=isolated; Path=/; HttpOnly" } });
    transport.get(sample.origin).intercept({ path: sample.path, ...(sample.platform === "douyin" ? { headers: { cookie: "passport_csrf_token=isolated" } } : {}) }).reply(200, sample.body);
    const submitted = await app.inject({ method: "POST", url: `/api/admin/studio/trends/boards/${sample.platform}/check`, headers, payload: {} });
    assert.equal(submitted.statusCode, 200); const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const signals = await app.inject({ url: `/api/admin/studio/trends/signals?platform=${sample.platform}`, headers });
    assert.equal(signals.statusCode, 200);
    const signal = signals.json().rows.find((row: { title: string }) => row.title === sample.title); assert.ok(signal);
    assert.equal(signal.observations[0].rank, 1); assert.equal(signal.observations[0].rawHeat, sample.heat);
    assert.deepEqual(signal.observations[0].metrics, { views: null, likes: null, comments: null });
    assert.equal(signal.disposition, "pending_relevance");
  }
  transport.assertNoPendingInterceptors();
});

test("限流、需要登录和响应损坏保留上次成功观察，只有有效空列表才报告空榜", async () => {
  const boards = "/api/admin/studio/trends/boards", board = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
    payload: { version: board.source.version, enabled: true } })).statusCode, 200);
  const before = (await app.inject({ url: "/api/admin/studio/trends/signals?platform=bilibili", headers })).json();
  const previous = board.collection, queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!, boss = await getBoss();
  for (const [status, errorCode, body] of [[429, "rate_limited", "upstream-private-key"], [403, "login_required", "login-private-key"], [200, "platform_failed", "invalid-private-key"]] as const) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(status, body);
    assert.equal((await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await assert.rejects(queue.run([job.data] as never[]), /平台热榜检查未完成/); await boss.cancel(queue.name, job.id);
    const response = await app.inject({ url: boards, headers }), current = response.json().rows.find((row: { platform: string }) => row.platform === "bilibili");
    assert.equal(current.collection.state, "failed"); assert.equal(current.collection.errorCode, errorCode);
    assert.equal(current.collection.checkedAt, previous.checkedAt); assert.equal(current.collection.itemCount, previous.itemCount);
    assert.ok(!response.body.includes("private-key"));
    assert.deepEqual((await app.inject({ url: "/api/admin/studio/trends/signals?platform=bilibili", headers })).json(), before);
  }
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, { code: 0, data: { list: [] } });
  assert.equal((await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} })).statusCode, 200);
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const empty = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal(empty.collection.state, "ready"); assert.equal(empty.collection.itemCount, 0); assert.equal(empty.collection.errorCode, null);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/trends/signals?platform=bilibili", headers })).json(), before);
  transport.assertNoPendingInterceptors();
});

test("请求期间暂停、更换会话或关闭采集，迟到的成功和登录错误均不覆盖历史或阻挡恢复", async () => {
  const boards = "/api/admin/studio/trends/boards", signals = "/api/admin/studio/trends/signals?platform=bilibili";
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!, boss = await getBoss();
  for (const action of ["pause", "session", "disable"]) {
    let board = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
    if (!board.source.enabled) {
      assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
        payload: { version: board.source.version, enabled: true } })).statusCode, 200);
      board = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
    }
    const before = (await app.inject({ url: signals, headers })).json();
    let reached!: () => void; const requested = new Promise<void>(resolve => { reached = resolve; });
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(() => {
      reached(); return { statusCode: action === "pause" ? 403 : 200,
        data: JSON.stringify({ code: 0, data: { list: [{ bvid: "BV1A411c7mD8", title: "迟到的新热点", stat: { view: 99999 } }] } }) };
    }).delay(100);
    assert.equal((await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job); const work = queue.run([job.data] as never[]);
    await requested;
    if (action === "pause") assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
      payload: { version: board.source.version, enabled: false } })).statusCode, 200);
    else if (action === "session") assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/bilibili", headers,
      payload: { version: 0, cookie: "SESSDATA=isolated-new-session" } })).statusCode, 200);
    else process.env.COLLECT_ENABLED = "false";
    try { await work; await boss.complete(queue.name, job.id); }
    finally { process.env.COLLECT_ENABLED = "true"; }
    const interrupted = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
    assert.equal(interrupted.collection.state, "interrupted"); assert.equal(interrupted.collection.errorCode, null);
    assert.equal(interrupted.collection.checkedAt, board.collection.checkedAt);
    assert.deepEqual((await app.inject({ url: signals, headers })).json(), before);
  }
  transport.assertNoPendingInterceptors();
});

test("同次榜单重复ID、超出数量或字节上限的响应不能留下部分排名观察", async () => {
  const path = "/api/admin/studio/trends/boards/bilibili/check", signals = "/api/admin/studio/trends/signals?platform=bilibili";
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!, boss = await getBoss();
  const before = (await app.inject({ url: signals, headers })).json(), item = { bvid: "BV1A411c7mD8", title: "不应写入的重复榜项", stat: {} };
  for (const body of [{ code: 0, data: { list: [item, item] } }, { code: 0, data: { list: Array.from({ length: 101 }, () => item) } }, "x".repeat(2 * 1024 ** 2 + 1)]) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, body);
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await assert.rejects(queue.run([job.data] as never[])); await boss.cancel(queue.name, job.id);
    assert.deepEqual((await app.inject({ url: signals, headers })).json(), before);
  }
  transport.assertNoPendingInterceptors();
});
