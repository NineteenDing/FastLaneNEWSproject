import '../../../tests/standalone.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {installModules} from '@aihot/backend/modules';import {sql} from '@aihot/backend/db';import {reconcilePublicNews,publicNewsJudgement} from '../backend/public-news.ts';
test('维护投影必须加载本站公开发布模块，不能静默回退旧新闻流水线',async()=>{
 installModules([]);await assert.rejects(reconcilePublicNews(new Date(),[]),/发布模块/);
 installModules([{name:'other',publication:{condition:()=>sql`false`,judgement:async()=>null}},
  {name:'studio',publication:{condition:()=>sql`false`,judgement:publicNewsJudgement}}]);
 await assert.rejects(reconcilePublicNews(new Date(),[]),/发布模块/);
});
