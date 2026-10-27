import {test} from 'node:test';import assert from 'node:assert/strict';
import {rankingForModel,draftForModel,factsForModel} from '../backend/topic-model-context.ts';
import type {DirectionRankingContext,TopicRecommendationResult} from '../contracts.ts';
test('model receives the frozen cohort and rules once, without analysis storage or unrelated event copies',()=>{
 const context={policy:'test',asOf:'2026-10-27T12:00:00Z',materialIds:['a'],materialAnalyses:{a:{summary:'large saved understanding'}},sharedSignals:{policy:'shared-topic-v2',events:[{id:'ea',materialIds:['a']},{id:'eb',materialIds:['b']}],candidates:[{materialId:'a',eventId:'ea'},{materialId:'b',eventId:'eb'}]}} as unknown as DirectionRankingContext;
 const projected=rankingForModel(context)!;assert.equal('materialAnalyses' in projected,false);assert.deepEqual(projected.sharedSignals?.events.map(e=>e.id),['ea']);assert.deepEqual(projected.sharedSignals?.candidates.map(e=>e.materialId),['a']);
 assert.equal(Object.keys(context.materialAnalyses!).length,1,'stored snapshot stays intact');
 const result={directions:[{id:'d',references:[{materialId:'a',quote:'Exact source evidence'}],score:{total:90}}],assignments:[{materialId:'a'}],sharedSignals:context.sharedSignals} as unknown as TopicRecommendationResult;
 const draft=draftForModel(result);assert.equal('sharedSignals' in draft,false);assert.equal('score' in draft.directions[0]!,false);assert.equal(draft.directions[0]!.references[0]!.quote,'Exact source evidence');
});
test('adjudication reuses only requested frozen factual evidence without optional impact analysis',()=>{
 const context={materialAnalyses:{a:{shared:{facts:[{text:'发生的事实',quotes:['逐字原文']}],impact:{value:90}}},b:{shared:{facts:[{text:'其他事实',quotes:['其他原文']}]}}}} as unknown as DirectionRankingContext;
 assert.deepEqual(factsForModel(context,['a']),[{materialId:'a',facts:[{text:'发生的事实',quotes:['逐字原文']}]}]);
});
