import {test} from 'node:test';import assert from 'node:assert/strict';
import {cutoffPreparationDue,usableForTopic} from '../backend/topic-cutoff-policy.ts';
test('20点批次18点启动准备，不把次日零点展示期限当生成时间',()=>{
 const end='2026-10-29T20:00:00+08:00';assert.equal(cutoffPreparationDue(end,'2026-10-29T17:59:59+08:00'),false);assert.equal(cutoffPreparationDue(end,'2026-10-29T18:00:00+08:00'),true);assert.equal(cutoffPreparationDue(end,end),false);
});
test('正式选题只冻结可用分析，少数失败和缺正文不阻断其余材料',()=>{
 const row={state:'completed',material:{body:'已核实新闻正文',bodyState:'ok'},analysis:{gates:{evidence:true},shared:{scope:'direct'}}};assert.equal(usableForTopic(row),true);
 assert.equal(usableForTopic({...row,state:'failed'}),false);assert.equal(usableForTopic({...row,material:{body:'',bodyState:'unconfirmed'}}),false);assert.equal(usableForTopic({...row,analysis:{...row.analysis,shared:{scope:'unrelated'}}}),false);
});
