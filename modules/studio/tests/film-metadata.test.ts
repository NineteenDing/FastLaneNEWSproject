import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import {after,test} from "node:test";
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from "undici";
import {config} from "@aihot/backend/config";
import {closeDb} from "@aihot/backend/db";
import {getBoss,stopBoss} from "@aihot/backend/jobs/queue";
import {serverModules} from "@aihot/backend/modules";
import {sourceResourceFixture} from "./source-resource-fixture.ts";
const {app,headers}=await sourceResourceFixture();
const previous=getGlobalDispatcher(),transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);
after(async()=>{setGlobalDispatcher(previous);await transport.close();await app.close();await stopBoss();await closeDb();});
const module=serverModules().find(row=>row.name==="studio")!;
async function drain(name:string){const boss=await getBoss(),queue=module.queues!.find(row=>row.name===name)!;for(;;){const jobs=await boss.fetch(name,{batchSize:100});if(!jobs.length)break;for(const job of jobs){await queue.run([job.data] as never[]);await boss.complete(name,job.id);}}}
test("合集详情只读目标作品，单集简介明确标记且不把推荐作品误作整剧",async()=>{
  config.allowPrivateNetworkFetch=true;
  transport.get("https://www.aitop100.cn").intercept({path:"/api/shortVideo/group/page?curPage=1&limit=20&orderByPopularity=true&queryPopularityDetail=true"})
    .reply(200,{code:0,data:{list:[{id:42,groupName:"目标合集",groupPopularity:100}]}});
  transport.get("https://www.aitop100.cn").intercept({path:"/artcenter/aivlogdetail/group/42.html"}).reply(200,
    `<script>window.__INITIAL_STATE__=${JSON.stringify({aicreationStore:{shortDetailGroupView:{id:42,details:null,groupWorks:[{idx:1,worksIntro:"这是目标合集的第一集简介。"}]},recommendations:[{id:99,worksIntro:"错误的推荐作品简介"}]}})};</script>`);
  assert.equal((await app.inject({method:"POST",url:"/api/admin/studio/film-boards/aitop100-drama/collect",headers,payload:{}})).statusCode,200);
  await drain("studio.film.collect");await drain("studio.film.metadata");
  const item=(await app.inject({url:"/api/site/film-boards?region=domestic"})).json().boards.find((row:{id:string})=>row.id==="aitop100-drama").items[0];
  assert.equal(item.sourceSummary,"这是目标合集的第一集简介。");assert.equal(item.summaryKind,"representative_episode");assert.equal(item.summaryStatus,"ready");
  for(let n=0;n<3;n++)await app.inject({url:"/api/site/film-boards"});transport.assertNoPendingInterceptors();
});
test("Vertical52详情按同一作品URL提取简介与制作国，演员国籍不能冒充作品国别",async()=>{
  const rows=Array.from({length:52},(_,i)=>`<a class="vchart-row" data-g="drama" data-p="ReelShort" href="https://verticalcharts.com/drama/${i+1}/"><span class="vchart-rank">${i+1}</span><span class="vchart-title">Work ${i+1}</span><span class="vchart-score">${99-i/10}</span></a>`).join("");
  transport.get("https://verticalcharts.com").intercept({path:"/charts/"}).reply(200,`Updated Oct 22, 2026<button data-g="drama">Drama 52</button><div class="vchart-wrapper" data-vc-type="rank" data-vc-limit="52">${rows}</div>`);
  for(let n=1;n<=40;n++)transport.get("https://verticalcharts.com").intercept({path:`/drama/${n}/`}).reply(200,
    `<script type="application/ld+json">${JSON.stringify({"@graph":[{"@type":"Person",name:"Actor",nationality:"Canada",description:"不是作品简介"},{"@type":"TVSeries",url:`https://verticalcharts.com/drama/${n}/`,description:`Source synopsis ${n}.`,...(n===1?{countryOfOrigin:{"@type":"Country",name:"United States"}}:{})}]})}</script>`);
  await app.inject({method:"POST",url:"/api/admin/studio/film-boards/verticalcharts-52/collect",headers,payload:{}});
  await drain("studio.film.collect");await drain("studio.film.metadata");
  const board=(await app.inject({url:"/api/site/film-boards?region=overseas"})).json().boards[0];
  assert.equal(board.items.length,40);assert.equal(board.items[0].sourceSummary,"Source synopsis 1.");assert.deepEqual(board.items[0].productionCountries,["美国"]);
  assert.deepEqual(board.items[1].productionCountries,[]);assert.equal(board.items[1].countryStatus,"not_provided");
  assert.equal(board.sourceTotal,52);assert.equal(board.sourceIssueDate,"2026-10-22");transport.assertNoPendingInterceptors();
});


test("定时详情补全可扫描真实UUID任务令牌，缓存已就绪时不重复访问来源",async()=>{
 const schedule=module.schedules!.find(row=>row.name==="studio.film.metadata.schedule");assert.ok(schedule);
 await schedule.run();transport.assertNoPendingInterceptors();
});
