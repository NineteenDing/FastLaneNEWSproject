import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import {after,test} from "node:test";
import {config} from "@aihot/backend/config";
import {closeDb} from "@aihot/backend/db";
import {getBoss,stopBoss} from "@aihot/backend/jobs/queue";
import {serverModules} from "@aihot/backend/modules";
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from "undici";
import {sourceResourceFixture} from "./source-resource-fixture.ts";
import {scheduleTrendNews} from "../backend/trend-news.ts";
const {app,headers}=await sourceResourceFixture();
const previous=getGlobalDispatcher(),transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch=true;config.modelCallsEnabled=false;
after(async()=>{await app.close();await stopBoss();await closeDb();setGlobalDispatcher(previous);await transport.close();});
const module=serverModules().find(row=>row.name==="studio")!,boards="/api/admin/studio/trends/boards",path="/api/admin/studio/trends/relevance";
async function run(name:string){const boss=await getBoss(),queue=module.queues!.find(q=>q.name===name)!;for(;;){const jobs=await boss.fetch(name,{batchSize:100});if(!jobs.length)break;for(const job of jobs){await queue.run([job.data] as never[]);await boss.complete(name,job.id);}}}
async function collect(titles:string[]){transport.get("https://api.bilibili.com").intercept({path:"/x/web-interface/popular"}).reply(200,{code:0,data:{list:titles.map((title,index)=>({bvid:`BV1${index}411c7mD8`,title,stat:{view:100000}}))}});assert.equal((await app.inject({method:"POST",url:boards+"/bilibili/check",headers,payload:{}})).statusCode,200);await run("studio.trends.collect");}
test("关键词在模型关闭时筛选AI影视与有限通用AI，排名不冒充事实，重复收集不收费",async()=>{
  assert.equal((await app.inject({method:"POST",url:path})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:path,headers,payload:{unknown:true}})).statusCode,400);
  await app.inject({method:"POST",url:boards+"/bilibili",headers,payload:{}});
  const board=(await app.inject({url:boards,headers})).json().rows.find((row:{platform:string})=>row.platform==="bilibili");
  await app.inject({method:"PATCH",url:`/api/admin/studio/news-sources/${board.source.id}/status`,headers,payload:{version:board.source.version,enabled:true}});
  const titles=["AI视频人物一致性方法","足球决赛回顾","Kimi新模型正式开源发布","演员今日穿搭"];
  await collect(titles);const submitted=await app.inject({method:"POST",url:path,headers,payload:{}});assert.equal(submitted.statusCode,200);assert.equal(submitted.json().queuedCount,4);await run("studio.trends.relevance");
  const rows=(await app.inject({url:"/api/admin/studio/trends/signals",headers})).json().rows;
  for(const [index,expected]of ["relevant","excluded","relevant","excluded"].entries()){const row=rows.find((row:{title:string})=>row.title===titles[index]);assert.equal(row.relevance.result.decision,expected);assert.equal(row.relevance.receiptId,null);assert.equal(row.relevance.modelIdentity,"local-keywords-no-model");}
  assert.equal((await app.inject({url:"/api/admin/studio/intelligence",headers})).json().total,0);
  await collect(titles);assert.equal((await app.inject({method:"POST",url:path,headers,payload:{}})).json().queuedCount,0);
});
test("标题更正使旧任务失效，恢复原版能续作",async()=>{
  await collect(["AI视频更正前标题"]);await app.inject({method:"POST",url:path,headers,payload:{}});
  const boss=await getBoss(),queue=module.queues!.find(q=>q.name==="studio.trends.relevance")!,[old]=await boss.fetch(queue.name);assert.ok(old);
  await collect(["足球更正后标题"]);await queue.run([old.data] as never[]);await boss.complete(queue.name,old.id);
  await app.inject({method:"POST",url:path,headers,payload:{}});await run(queue.name);
  assert.equal((await app.inject({url:"/api/admin/studio/trends/signals?q=更正后",headers})).json().rows[0].relevance.result.decision,"excluded");
  await collect(["AI视频更正前标题"]);await app.inject({method:"POST",url:path,headers,payload:{}});await run(queue.name);
  assert.equal((await app.inject({url:"/api/admin/studio/trends/signals?q=更正前",headers})).json().rows[0].relevance.result.decision,"relevant");
});
test("相关热榜原文进入普通新闻且不重复入库；未取到原文不造事实",async()=>{
  const body="AI视频工具公布人物一致性的新能力，支持镜头控制和参考图。官方说明复杂运动仍有使用限制。".repeat(8);
  transport.get("https://www.bilibili.com").intercept({path:"/video/BV10411c7mD8"}).reply(200,`<html><head><title>AI视频人物一致性正式更新</title><meta property="article:published_time" content="${new Date().toISOString()}"></head><body><article><h1>AI视频人物一致性正式更新</h1><p>${body}</p></article></body></html>`,{headers:{"content-type":"text/html"}});
  assert.ok((await scheduleTrendNews()).queued>0);await run("studio.trends.news");
  const result=(await app.inject({url:"/api/admin/studio/intelligence?kind=news",headers})).json();assert.equal(result.total,1);
  const detail=await app.inject({url:`/api/admin/studio/intelligence/${encodeURIComponent(result.rows[0].id)}`,headers});assert.equal(detail.statusCode,200);assert.ok(detail.json().body.includes("人物一致性"));
  await scheduleTrendNews();await run("studio.trends.news");assert.equal((await app.inject({url:"/api/admin/studio/intelligence?kind=news",headers})).json().total,1);
  assert.equal((await app.inject({url:"/api/admin/studio/model-usage",headers})).json().rows.find((row:{key:string})=>row.key==="analysis").attemptsThisMonth,0);transport.assertNoPendingInterceptors();
});
