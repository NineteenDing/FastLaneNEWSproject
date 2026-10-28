import assert from 'node:assert/strict';import {test} from 'node:test';
import {routePublic} from '../backend/editorial-v2.ts';
test('四通道：COL产业参考可公开但非精选；真实影视出圈越过普通评分门槛',()=>{
 const common={dimensions:{I:70,M:65,D:80,P:20,F:40},observed:null,freshObserved:null,state:'unknown' as const,aiCentral:false,filmRelevant:true,factsAvailable:true,evidence:85,referenceVerified:true};
 assert.equal(routePublic({...common,scope:'adjacent_industry'}).route,'market_reference');
 assert.equal(routePublic({...common,scope:'non_ai_film',dimensions:{I:20,M:10,D:20,P:0,F:0},breakout:true}).route,'verified_breakout');
 assert.equal(routePublic({...common,scope:'unrelated',breakout:true}).route,'excluded');
});

import {referenceCapacity} from '../backend/reference-quota.ts';
test('20%上限按事件计数且支持低量和大于两条参考的日子',()=>{
 for(const [core,expected] of [[0,0],[1,0],[3,0],[4,1],[7,1],[8,2],[12,3],[100,25]])assert.equal(referenceCapacity(core!),expected);
 for(let core=0;core<=200;core++){const refs=referenceCapacity(core);assert.ok(!refs||refs/(core+refs)<=0.2);assert.ok((refs+1)/(core+refs+1)>0.2);}
});
test('固定32例覆盖四通道、低热度与出圈的门槛，缺测不是出圈',()=>{
 const base={dimensions:{I:90,M:90,D:90,P:90,F:90},observed:null,freshObserved:null,state:'unknown' as const,aiCentral:true,filmRelevant:true,factsAvailable:true,evidence:80,referenceVerified:true};
 for(const scope of ['direct_ai_film','general_ai','adjacent_industry','non_ai_film'] as const)for(const breakout of [false,true])for(const state of ['unknown','complete'] as const)for(const low of [false,true]){
  const film=scope==='adjacent_industry'||scope==='non_ai_film',d=low?{I:10,M:10,D:10,P:0,F:0}:base.dimensions;
  const actual=routePublic({...base,scope,aiCentral:!film,dimensions:d,state,observed:state==='complete'?0:null,breakout}).route;
  if(breakout)assert.equal(actual,'verified_breakout');else if(low)assert.equal(actual,'excluded');else if(film)assert.equal(actual,'market_reference');else if(scope==='direct_ai_film')assert.equal(actual,'direct_selected');else assert.equal(actual,'general_ai_selected');
 }
 assert.equal(routePublic({...base,scope:'unrelated',breakout:true}).route,'excluded');
 assert.equal(routePublic({...base,scope:'direct_ai_film',factsAvailable:false,breakout:true}).route,'excluded');
});
import {sharedMaterialSchema} from '../backend/shared-material.ts';
import {MATERIAL_OUTPUT_TEMPLATE} from '../backend/material-wire.ts';
import {editorialEvidenceScope} from '../backend/editorial-evidence.ts';
test('普通相机日期不能充当AI核心引证；非影视股市不能靠旧布尔值借影视通道',()=>{
 const s:any=structuredClone(MATERIAL_OUTPUT_TEMPLATE.shared);Object.assign(s,{editorialScope:'direct_ai_film',aiCentral:true,filmRelevant:true,scopeFactIds:[0],aiRole:'所谓AI创作者器材'});
 s.facts=[{text:'Sony FX5延期至1月8日',quotes:['Sony FX5 ships January 8.']}];
 assert.equal(sharedMaterialSchema.safeParse(s).success,false);
 Object.assign(s,{editorialScope:'non_ai_film',aiCentral:false,aiRole:null,scopeFactIds:undefined});s.facts=[{text:'A股通信设备板块高开',quotes:['A股通信设备板块高开']}];
 assert.equal(editorialEvidenceScope(s).scope,'unrelated');
});
import '../../../tests/standalone.ts';
import {scoreMaterialV2} from '../backend/filter-scoring.ts';
import {freezeSharedTopicSignals} from '../backend/topic-signals.ts';
import {heatSnapshot} from '../backend/editorial-v2.ts';
test('真实出圈允许普通维度未知，公开与内部材料候选一致',()=>{
 const shared:any=structuredClone(MATERIAL_OUTPUT_TEMPLATE.shared);Object.assign(shared,{scope:'important_ai',editorialScope:'general_ai',aiCentral:true,filmRelevant:false,scopeFactIds:[0],aiRole:'AI模型发布',event:null});
 shared.v2.E.value=80;shared.facts=[{text:'AI模型发布',quotes:['AI model released']}];shared.publicSummary='公司发布新的AI模型，并开放访问。';
 const asOf='2026-10-28T12:00:00Z', material:any={id:'news:null-dim',kind:'news',title:'AI发布',body:'AI model released',bodyState:'ok',publishedAt:asOf,collectedAt:asOf,updatedAt:asOf,source:{id:'source',platform:'news'},observations:[],metrics:null,trends:[{platform:'zhihu',active:true,observations:[{rank:1,observedAt:asOf}]}]};
 const analysis:any={shared,gates:{evidence:true},sharedEventId:'test-event'};
 const event:any={event:{time:null,timeConflict:false},breakout:{triggered:true},heatV2:heatSnapshot({canonicalEventId:'test-event',asOf,observationScope:'public',state:'complete',observed:99,freshObserved:99})};
 const score=scoreMaterialV2({materialId:material.id,title:material.title,kind:'news',publishedAt:new Date(asOf),collectedAt:new Date(asOf),sourceKey:'k',private:false,complete:true,eventId:'test-event',analysis},event,asOf);
 assert.equal(score.internal.eligible,true);assert.equal(score.eligibleSelected,true);assert.equal(score.route,'verified_breakout');
 assert.equal(freezeSharedTopicSignals([{material,analysis}],asOf)!.candidates[0]!.path,'breakout');
});
