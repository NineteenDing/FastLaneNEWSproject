import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { getBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { addDays, beijingAt, beijingDate } from "@aihot/contracts/time";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("影视榜匿名读取真实空状态，独立入口与版本化采集范围设置，不凭空展示数据", async () => {
  const response = await app.inject({ url: "/api/site/film-boards" }); assert.equal(response.statusCode, 200);
  const boards = response.json().boards; assert.equal(boards.length, 8);
  assert.equal(new Set(boards.map((board: { id: string }) => board.id)).size, 8);
  assert.ok(boards.every((board: { id: string; items: unknown[]; snapshotAt: string | null; limit: number }) =>
    !board.items.length && board.snapshotAt === null && board.limit === (board.id === "verticalcharts-52" ? 40 : 20)));
  const green = boards.find((board: { id: string }) => board.id === "lvpaopao");
  assert.equal(green.state, "not_connected"); assert.equal(green.name, "绿泡泡短剧 · 今日必看");
  const domestic = await app.inject({ url: "/api/site/film-boards?region=domestic" }); assert.equal(domestic.json().boards.length, 7);
  assert.equal((await app.inject({ url: "/api/site/film-boards?region=unknown" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/admin/studio/film-boards" })).statusCode, 401);
  const url = "/api/admin/studio/film-boards/aitop100-short";
  assert.equal((await app.inject({ method: "PUT", url, payload: { version: 0, enabled: false, limit: 20 } })).statusCode, 401);
  const saved = await app.inject({ method: "PUT", url, headers, payload: { version: 0, enabled: false, limit: 20 } }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().version, 1); assert.equal(saved.json().enabled, false); assert.equal(saved.json().limit, 20);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 0, enabled: true, limit: 20 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 1, enabled: true, limit: 101 } })).statusCode, 400);
  const current = (await app.inject({ url: "/api/admin/studio/film-boards", headers })).json().boards.find((board: { id: string }) => board.id === "aitop100-short");
  assert.equal(current.version, 1); assert.equal(current.enabled, false); assert.equal(current.limit, 20); assert.deepEqual(current.items, []);
});

test("榜单采集保留官方顺序与原热度，失败仍读最后成功快照，页面读取不发请求", async () => {
  config.allowPrivateNetworkFetch = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/film-boards/aitop100-short", headers, payload: { version: 1, enabled: true, limit: 20 } })).statusCode, 200);
  let requests = 0;
  transport.get("https://www.aitop100.cn").intercept({ method: "GET", path: "/api/shortVideo/works/page?curPage=1&limit=20&onlyNoGroup=true&orderByPopularity=true" }).reply(() => {
    requests++;
    return requests === 1 ? { statusCode: 200, data: JSON.stringify({ code: 0, data: { list: [
      { id: 11, worksName: "官方首位", totalPopularity: 20, workCover: "https://covers.example/11.png", views: 2 },
      { id: 12, worksName: "官方次位", totalPopularity: 3000, workCover: "https://covers.example/12.png", views: 99 },
    ] } }) } : { statusCode: 503, data: "temporary failure" };
  }).persist();
  const url = "/api/admin/studio/film-boards/aitop100-short/collect";
  assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
  let response = await app.inject({ method: "POST", url, headers, payload: {} }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().queued, true); assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.film.collect"); assert.ok(queue);
  const boss = await getBoss(); let [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  response = await app.inject({ url: "/api/site/film-boards?region=domestic" });
  const board = response.json().boards.find((board: { id: string }) => board.id === "aitop100-short");
  assert.equal(board.limit, 20);
  assert.deepEqual(Object.keys(board.items[0]).sort(), ["id", "position", "title", "url", "author", "sourceSummary", "metrics", "productionCountries", "countryStatus", "summaryKind", "summaryStatus"].sort());
  assert.equal((await app.inject({ url: "/api/site/film-boards" })).body.includes("covers.example"), false);
  assert.equal(board.state, "ready"); assert.deepEqual(board.items.map((item: { title: string }) => item.title), ["官方首位", "官方次位"]);
  assert.equal(board.items[0].position, 1); assert.equal(board.items[0].metrics[0].name, "来源综合热度"); assert.equal(board.items[0].metrics[0].value, 20);
  assert.equal(board.items[0].url, "https://www.aitop100.cn/artcenter/aivlogdetail/works/11.html"); assert.ok(board.snapshotAt);
  await app.inject({ url: "/api/site/film-boards" }); assert.equal(requests, 1, "读页只读取已存快照");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, true);
  [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const failed = (await app.inject({ url: "/api/site/film-boards" })).json().boards.find((board: { id: string }) => board.id === "aitop100-short");
  assert.equal(failed.state, "failed"); assert.deepEqual(failed.items, board.items); assert.equal(failed.snapshotAt, board.snapshotAt); assert.ok(failed.error);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/film-boards/lvpaopao/collect", headers, payload: {} })).statusCode, 409);
});

test("现用AI短剧、红果四类及Vertical52保留顺序和指标，旧海外榜拒绝采集", async () => {
  transport.get("https://www.aitop100.cn").intercept({path:"/api/shortVideo/group/page?curPage=1&limit=20&orderByPopularity=true&queryPopularityDetail=true"})
    .reply(200,{code:0,data:{list:[{id:42,groupName:"AI合集",groupPopularity:99}]}});
  for(const route of ["hot-drama","hot-real-drama","hot-comic-drama","hot-ai-drama"]){
    const rows=Array.from({length:20},(_,i)=>({seriesId:String(i+1),rank:i+1,title:`${route}官网热播${i+1}`,href:`/detail?series_id=${i+1}`,heatText:"12万热度",description:"来源提供的作品简介"}));
    transport.get("https://hongguoduanju.com").intercept({path:`/rank/${route}`}).reply(200,`<script>_ROUTER_DATA = ${JSON.stringify({loaderData:{[`rank_${route}/page`]:{content:{isSuccess:true,rankList:rows},updatedText:"10月24日已更新"}}})};</script>`);
  }
  const rows=Array.from({length:52},(_,i)=>`<a class="vchart-row" data-g="romance" data-p="ReelShort" href="https://verticalcharts.com/drama/work-${i+1}/"><span class="vchart-rank">${i+1}</span><span class="vchart-title">Work ${i+1}</span><span class="vchart-score">${99-i/10}</span></a>`).join("");
  transport.get("https://verticalcharts.com").intercept({path:"/charts/"}).reply(200,`Updated Oct 22, 2026<button data-g="romance">Romance 52</button><button data-p="ReelShort">ReelShort</button><div class="vchart-wrapper" data-vc-type="rank" data-vc-limit="52">${rows}</div>`);
  const queue=serverModules().find(m=>m.name==="studio")!.queues!.find(q=>q.name==="studio.film.collect")!,boss=await getBoss();
  for(const id of ["aitop100-drama","hongguo-web","hongguo-real","hongguo-comic","hongguo-ai","verticalcharts-52"]){
    const response=await app.inject({method:"POST",url:`/api/admin/studio/film-boards/${id}/collect`,headers,payload:{}});assert.equal(response.statusCode,200,response.body);
    const [job]=await boss.fetch(queue.name);assert.ok(job);await queue.run([job.data] as never[]);await boss.complete(queue.name,job.id);
  }
  const boards=(await app.inject({url:"/api/site/film-boards"})).json().boards;
  assert.equal(boards.find((b:{id:string})=>b.id==="verticalcharts-52").items.length,40);
  for(const id of ["hongguo-web","hongguo-real","hongguo-comic","hongguo-ai"]){const board=boards.find((b:{id:string})=>b.id===id);assert.equal(board.items.length,20);assert.equal(board.items[0].metrics[0].value,null);assert.equal(board.items[0].sourceSummary,"来源提供的作品简介");}
  for(const id of ["dramabox","reelshort","netshort","pinedrama"])assert.equal((await app.inject({method:"POST",url:`/api/admin/studio/film-boards/${id}/collect`,headers,payload:{}})).statusCode,409);
});

test("香港07点才排每日采集且不重复，停用改版后旧任务不能请求或覆盖最后成功结果", async t => {
  const now = beijingAt(addDays(beijingDate(new Date()), 1), "07:00");
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() - 60000 });
  const schedule = serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === "studio.film.schedule"); assert.ok(schedule);
  await schedule.run();
  t.mock.timers.setTime(now.getTime()); assert.equal((await schedule.run() as { queued: number }).queued, 6);
  assert.equal((await schedule.run() as { queued: number }).queued, 0);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.film.collect")!, boss = await getBoss();
  const jobs=await boss.fetch(queue.name,{batchSize:100}),job=jobs.find(job=>(job.data as {id:string}).id==="aitop100-short");assert.ok(job);
  for(const other of jobs)if(other.id!==job.id)await boss.cancel(queue.name,other.id);
  const before = (await app.inject({ url: "/api/site/film-boards" })).json().boards.find((board: { id: string }) => board.id === "aitop100-short");
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/film-boards/aitop100-short", headers, payload: { version: 2, enabled: false, limit: 20 } })).statusCode, 200);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const after = (await app.inject({ url: "/api/site/film-boards" })).json().boards.find((board: { id: string }) => board.id === "aitop100-short");
  assert.equal(after.state, "paused"); assert.equal(after.snapshotAt, before.snapshotAt); assert.deepEqual(after.items, before.items);
});

test("国内外影视榜真实网页展示原指标、实际范围与未接通入口，桌面窄屏可导航且长题不溢出", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { mkdir } = await import("node:fs/promises");
  await mkdir(".impeccable/review", { recursive: true }); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage(), faults: string[] = [];
  page.on("pageerror", error => faults.push(error.message));
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      let response = await page.goto(web.origin + "/film/domestic?board=hongguo-web"); assert.equal(response?.status(), 200);
      await expect(page.getByRole("heading", { name: "红果热播榜", exact: true })).toBeVisible();
      await expect(page.getByText("仅供分享学习使用，", { exact: false })).toBeVisible();
      await expect(page.getByRole("list", { name: "作品列表" }).locator("img")).toHaveCount(0);
      await expect(page.getByRole("list", { name: "作品列表" }).getByRole("listitem")).toHaveCount(20);
      await expect(page.getByText("12万热度",{exact:true}).first()).toBeVisible();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await expect(page.getByRole("navigation", { name: "选择影视榜单" }).getByRole("link")).toHaveCount(2);
      for (const category of ["真人剧", "漫剧", "AI剧", "总热播"]) {
        await page.getByRole("navigation", { name: "红果热播榜分类" }).getByRole("link", { name: category, exact: true }).click();
        await expect(page.getByRole("navigation", { name: "红果热播榜分类" }).getByRole("link", { name: category, exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("list", { name: "作品列表" }).getByRole("listitem")).toHaveCount(20);
      }
      await page.getByRole("link", { name: "AI TOP100", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "AI TOP100分类" }).getByRole("link")).toHaveCount(2);
      await page.getByRole("link", { name: "AI短剧榜", exact: true }).click();
      await expect(page.getByRole("link", { name: "AI合集", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "红果热播榜", exact: true }).click();
      await page.screenshot({ path: `.impeccable/review/phase2-film-domestic-${width}.png` });
      await expect(page.getByRole("link",{name:"绿泡泡短剧 · 今日必看",exact:true})).toHaveCount(0);
      response=await page.goto(web.origin+"/film/overseas?board=dramabox");assert.equal(response?.status(),200);
      await expect(page.getByRole("heading",{name:"Vertical 52",exact:true})).toBeVisible();
      await expect(page.getByRole("list",{name:"作品列表"}).getByRole("listitem")).toHaveCount(40);
      await expect(page.getByRole("list",{name:"作品列表"}).locator("img")).toHaveCount(0);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth>innerWidth"),false);
      await page.screenshot({path:`.impeccable/review/phase2-film-overseas-${width}.png`});
    }
    assert.deepEqual(faults, []);
  } finally { await browser.close(); await web.stop(); }
});
