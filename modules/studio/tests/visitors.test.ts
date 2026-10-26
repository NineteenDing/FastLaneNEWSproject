import '../../../tests/setup.ts';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {sourceResourceFixture} from './source-resource-fixture.ts';
import {closeDb} from '@aihot/backend/db';
import {stopBoss} from '@aihot/backend/jobs/queue';
const {app,headers}=await sourceResourceFixture();after(async()=>{await app.close();await stopBoss();await closeDb();});
test('匿名访问按浏览器与会话去重，累计活跃时长重试不累加，管理员可按日期及页面查看',async t=>{
  const start=Date.parse('2026-08-01T10:00:00+08:00');t.mock.timers.enable({apis:['Date'],now:start});
  const visitor=randomUUID(),session=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID();
  const post=(id:string,path:string,activeMs:number,visitorId=visitor,sessionId=session)=>app.inject({method:'POST',url:'/api/site/visits',payload:{id,visitorId,sessionId,path,activeMs},headers:{origin:'http://localhost'}});
  assert.equal((await post(a,'/all',0)).statusCode,204);
  t.mock.timers.setTime(start+20000);assert.equal((await post(a,'/all',20000)).statusCode,204);await post(a,'/all',20000);
  await post(b,'/hot',0);t.mock.timers.setTime(start+30000);await post(b,'/hot',10000);
  const secondVisitor=randomUUID(),secondSession=randomUUID();await post(c,'/all',0,secondVisitor,secondSession);
  t.mock.timers.setTime(start+40000);await post(c,'/all',10000,secondVisitor,secondSession);
  assert.equal((await post(randomUUID(),'/admin/studio/writing',0)).statusCode,400);
  assert.equal((await app.inject({url:'/api/admin/studio/visitors?from=2026-08-01&to=2026-08-01'})).statusCode,401);
  const result=await app.inject({url:'/api/admin/studio/visitors?from=2026-08-01&to=2026-08-01',headers});assert.equal(result.statusCode,200,result.body);
  const stats=result.json();assert.equal(stats.overview.visitors,2);assert.equal(stats.overview.pageViews,3);assert.equal(stats.overview.visits,2);assert.equal(stats.overview.activeMs,40000);assert.equal(stats.overview.averageVisitMs,20000);
  assert.equal(stats.pages.find((p:{path:string})=>p.path==='/all').activeMs,30000);
  assert.equal((await app.inject({url:'/api/admin/studio/visitors?from=2026-08-02&to=2026-08-02',headers})).json().overview.pageViews,0);
});
test('真实公开页自动记录匿名访问，工作台浏览不新增前台访问次数',async()=>{
  const {chromium,expect}=await import('@playwright/test'),{startWebServer}=await import('../../../apps/web/tests/web-server.ts');
  const web=await startWebServer(app.server),browser=await chromium.launch(),context=await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'});
  const page=await context.newPage();
  const stats=async()=>(await app.inject({url:'/api/admin/studio/visitors',headers})).json().overview;
  try{
    await page.goto(web.origin+'/about');
    await expect.poll(async()=>(await stats()).pageViews).toBe(1);
    const visitor=await page.evaluate(()=>localStorage.getItem('fl.visitor'));assert.match(visitor!,/^[a-f0-9-]{36}$/);
    const [name,...value]=headers.cookie.split('=');await context.addCookies([{name:name!,value:value.join('='),url:web.origin}]);
    await page.goto(web.origin+'/admin/studio/settings/visitors');await expect(page.getByRole('heading',{name:'访问统计',exact:true})).toBeVisible();
    assert.equal((await stats()).pageViews,1);
    assert.equal((await stats()).visitors,1);
  }finally{await context.close();await browser.close();await web.stop();}
});
