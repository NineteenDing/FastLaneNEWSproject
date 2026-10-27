import {test} from 'node:test';import assert from 'node:assert/strict';
import {groundResolutionQuotes} from '../backend/review-quote-recovery.ts';
test('optional resolution quotes retain exact provenance; ungrounded citations become explicit partial findings',()=>{
 const value={checkedParts:['a:1'],resolutions:[{opinionId:'o',decision:'accept',reason:'核对事实',quotes:[{materialId:'a',quote:'GPT-6 已发布'},{materialId:'b',quote:'虚构断言'}]}]};
 const result:any=groundResolutionQuotes(value,new Map([['a','GPT‑6 已发布'],['b','实际原文']]));
 assert.deepEqual(result.resolutions[0].quotes,[{materialId:'a',quote:'GPT‑6 已发布'}]);assert.equal(result.resolutions[0].decision,'partial');assert.match(result.resolutions[0].reason,/未核验/);assert.equal(value.resolutions[0]!.decision,'accept');
});
