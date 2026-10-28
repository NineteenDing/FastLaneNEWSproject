import {test} from 'node:test';import assert from 'node:assert/strict';
import {freezeSharedTopicSignals} from '../backend/topic-signals.ts';
import {MATERIAL_OUTPUT_TEMPLATE} from '../backend/material-wire.ts';
import type {TopicBatchMaterial,TopicMaterialAnalysis} from '../contracts.ts';
test('internal cutoff keeps the same strong platform-attention breakout semantics as public admission',()=>{
 const shared:any=structuredClone(MATERIAL_OUTPUT_TEMPLATE.shared);Object.assign(shared,{scope:'important_ai',editorialScope:'general_ai',aiCentral:true,filmRelevant:false});shared.v2.I.value=70;shared.v2.D.value=85;shared.v2.E.value=85;shared.v2.M.value=50;shared.v2.P.value=0;
 const material={id:'news:a',title:'AI model release',kind:'news',body:'Original source facts',bodyState:'ok',publishedAt:'2026-10-27T12:00:00Z',collectedAt:'2026-10-27T12:01:00Z',updatedAt:'2026-10-27T12:01:00Z',source:{id:'source',platform:'news'},observations:[],metrics:null,trends:[{platform:'zhihu',observations:[{rank:11,observedAt:'2026-10-27T16:00:00Z'}],active:false}]} as unknown as TopicBatchMaterial;
 const analysis={shared,gates:{evidence:true},sharedEventId:'event-a'} as TopicMaterialAnalysis;
 const result=freezeSharedTopicSignals([{material,analysis}],'2026-10-28T00:00:00Z')!;
 assert.equal(result.events[0]!.breakout.triggered,true);assert.equal(result.candidates[0]!.path,'breakout');
});

test('internal cutoff retains a verified earlier top-ten rank without using future observations',()=>{
 const shared:any=structuredClone(MATERIAL_OUTPUT_TEMPLATE.shared);Object.assign(shared,{scope:'important_ai',editorialScope:'general_ai',aiCentral:true,filmRelevant:false});shared.v2.I.value=60;shared.v2.D.value=60;shared.v2.E.value=60;shared.v2.M.value=50;shared.v2.P.value=0;
 const material={id:'news:a',title:'AI model release',kind:'news',body:'Original source facts',bodyState:'ok',publishedAt:'2026-10-27T12:00:00Z',collectedAt:'2026-10-27T12:01:00Z',updatedAt:'2026-10-27T12:01:00Z',source:{id:'source',platform:'news'},observations:[],metrics:null,trends:[{platform:'zhihu',observations:[{rank:15,bestRank:8,observedAt:'2026-10-27T16:00:00Z'}],active:false}]} as unknown as TopicBatchMaterial;
 const analysis={shared,gates:{evidence:true},sharedEventId:'event-a'} as TopicMaterialAnalysis;
 const result=freezeSharedTopicSignals([{material,analysis}],'2026-10-28T00:00:00Z')!;
 assert.equal(result.events[0]!.breakout.triggered,true);assert.equal(result.candidates[0]!.path,'breakout');
 material.trends![0]!.observations=[{rank:45,observedAt:'2026-10-27T16:00:00Z'},{rank:8,bestRank:8,observedAt:'2026-10-28T01:00:00Z'}] as any;
 const beforeFuture=freezeSharedTopicSignals([{material,analysis}],'2026-10-28T00:00:00Z')!;
 assert.equal(beforeFuture.events[0]!.breakout.triggered,false);
});
