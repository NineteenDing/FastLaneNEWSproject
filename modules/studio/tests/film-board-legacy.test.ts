import '../../../tests/setup.ts';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { sourceResourceFixture } from './source-resource-fixture.ts';

after(async () => { await stopBoss(); await closeDb(); });
test('启动收紧旧榜单时仅删独有封面缓存，新闻共用缓存不变，旧快照不再含图片', async () => {
  const urls = ['https://covers.example/shared.png', 'https://covers.example/only-board.png'];
  const files: string[] = [];
  for (const url of urls) {
    const hash = createHash('sha256').update('thumb|' + url).digest('hex');
    const file = path.join(config.dataDir, 'imgcache', hash.slice(0, 2), hash);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'existing-cache'); files.push(file);
  }
  await sql`INSERT INTO sources (id,name,kind,tier) VALUES ('legacy-cover-source','News','rss','T1')`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,media)
    VALUES ('legacy-shared-cover','legacy-cover-source','legacy-cover','https://news.example/story','新闻',now(),now(),${sql.json([{url:urls[0]}])})`;
  await sql`INSERT INTO studio_film_boards (id,definition,snapshot) VALUES ('aitop100-short', ${sql.json({enabled:true,limit:30})},
    ${sql.json({fetchedAt:new Date().toISOString(),requestedLimit:30,items:urls.map((url,index)=>({id:String(index),position:index+1,title:'旧榜',url:'https://www.aitop100.cn/works/'+index,author:null,coverUrl:url,description:'旧简介',metrics:[]}))})})`;
  const { app } = await sourceResourceFixture();
  try {
    assert.equal(await readFile(files[0]!, 'utf8'), 'existing-cache');
    await assert.rejects(readFile(files[1]!), {code:'ENOENT'});
    const response=await app.inject({url:'/api/site/film-boards'}); assert.equal(response.statusCode,200); assert.ok(!response.body.includes('covers.example'));
    const board=response.json().boards.find((item:{id:string})=>item.id==='aitop100-short');
    assert.equal(board.limit,20); assert.equal(board.version,1); assert.equal(board.items.length,2);
    assert.deepEqual(Object.keys(board.items[0]).sort(),['id','position','title','url','author','metrics','sourceSummary','productionCountries','countryStatus','summaryKind','summaryStatus'].sort());
  } finally { await app.close(); }
});
