import '../../../tests/setup.ts';
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {config} from '@aihot/backend/config';
import {closeDb} from '@aihot/backend/db';
import {getBoss,stopBoss} from '@aihot/backend/jobs/queue';
import {serverModules} from '@aihot/backend/modules';
import {sourceResourceFixture} from './source-resource-fixture.ts';
const {app,headers}=await sourceResourceFixture();
const previous=getGlobalDispatcher(),transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);
after(async()=>{setGlobalDispatcher(previous);await transport.close();await app.close();await stopBoss();await closeDb();});
let calls=0;
transport.get('https://www.dramabox.com').intercept({method:'GET',path:'/'}).reply(200,`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{smallData:[{id:1265,items:[{bookId:'a',bookName:'Second Chance',replacedBookName:'second-chance',introduction:'A director gets a second chance.',viewCount:100},{bookId:'b',bookName:'Hidden Prince',replacedBookName:'hidden-prince',viewCount:80}]}]}}})}</script>`).persist();
transport.get('https://api.deepseek.com').intercept({method:'POST',path:'/v1/chat/completions'}).reply(request=>{
  calls++;const body=JSON.parse(String(request.body));assert.equal(body.model,'deepseek-flash');
  const input=JSON.parse(body.messages.at(-1).content);
  return {statusCode:200,data:JSON.stringify({choices:[{message:{content:JSON.stringify({items:input.items.map((item:{key:string;title:string;summary:string|null})=>({key:item.key,titleZh:item.title==='Second Chance'?'重来一次':'隐秘王子',summaryZh:item.summary?'一位导演获得重新开始的机会。':null}))})}}],usage:{prompt_tokens:200,completion_tokens:80}})};
}).persist();
test('国外榜单批量翻译中文标题和已有摘要，封面仍用原名；同文本重收集和读页不重复付费',async()=>{
  config.allowPrivateNetworkFetch=true;config.modelCallsEnabled=true;
  assert.equal((await app.inject({method:'PUT',url:'/api/admin/studio/model-connection',headers,payload:{version:0,baseUrl:'https://api.deepseek.com/v1',apiKey:'film-translation-test-only',analysisModel:'deepseek-flash',qualityModel:'deepseek-flash'}})).statusCode,200);
  const boss=await getBoss();
  async function collect(){
    assert.equal((await app.inject({method:'POST',url:'/api/admin/studio/film-boards/dramabox/collect',headers,payload:{}})).statusCode,200);
    const queue=serverModules().find(m=>m.name==='studio')!.queues!.find(q=>q.name==='studio.film.collect')!;
    const [job]=await boss.fetch(queue.name);assert.ok(job);await queue.run([job.data] as never[]);await boss.complete(queue.name,job.id);
  }
  await collect();
  const queue=serverModules().find(m=>m.name==='studio')!.queues!.find(q=>q.name==='studio.film.translate');assert.ok(queue,'采集后应存在独立的翻译队列');
  const [job]=await boss.fetch(queue.name);assert.ok(job);await queue.run([job.data] as never[]);await boss.complete(queue.name,job.id);
  let board=(await app.inject({url:'/api/site/film-boards?region=overseas'})).json().boards.find((b:{id:string})=>b.id==='dramabox');
  assert.equal(board.items[0].title,'Second Chance');assert.equal(board.items[0].titleZh,'重来一次');assert.equal(board.items[0].summaryZh,'一位导演获得重新开始的机会。');
  assert.equal(board.items[1].summaryZh,null);assert.ok(!JSON.stringify(board).includes('coverUrl'));assert.equal(calls,1);
  await collect();
  const next=await boss.fetch(queue.name);if(next?.length){await queue.run([next[0]!.data] as never[]);await boss.complete(queue.name,next[0]!.id);}
  for(let n=0;n<3;n++)await app.inject({url:'/api/site/film-boards?region=overseas'});
  assert.equal(calls,1,'按文本指纹复用，排名更新/页面读取不重新翻译');
});
test('国外榜单实际页面中文首行原名次行，文字封面保留原名且没有图片请求',async()=>{
  const {chromium,expect}=await import('@playwright/test'),{startWebServer}=await import('../../../apps/web/tests/web-server.ts');
  transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const web=await startWebServer(app.server),browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1440,height:900}});
  try{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.goto(web.origin+'/film/overseas?board=dramabox');
      const item=page.getByRole('list',{name:'作品列表'}).getByRole('listitem').first();
      await expect(item.getByRole('heading',{name:'重来一次',exact:true})).toBeVisible();
      await expect(item.locator('[aria-hidden="true"]')).toContainText('Second Chance');
      await expect(item.locator('p').filter({hasText:'Second Chance'})).toBeVisible();
      await expect(item.getByText('一位导演获得重新开始的机会。',{exact:true})).toBeVisible();await expect(item.locator('img')).toHaveCount(0);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      await page.screenshot({path:`.impeccable/review/admin-round2-film-translated-${width}.png`});
    }
    assert.equal(calls,1);
  }finally{await browser.close();await web.stop();}
});
