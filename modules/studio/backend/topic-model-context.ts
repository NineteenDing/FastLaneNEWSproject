import type {DirectionRankingContext,TopicRecommendationResult} from '../contracts.ts';
/** Storage-only analyses are not another model input. Frozen bodies are packeted separately in full. */
export function rankingForModel(context:DirectionRankingContext|null|undefined){
 if(!context)return context;
 const {materialAnalyses:_stored,...out}=context;
 if(out.materialIds&&out.sharedSignals){const ids=new Set(out.materialIds),candidates=out.sharedSignals.candidates.filter(row=>ids.has(row.materialId)),events=new Set(candidates.map(row=>row.eventId));
  out.sharedSignals={...out.sharedSignals,candidates,events:out.sharedSignals.events.filter(row=>events.has(row.id)).map(row=>({...row,materialIds:row.materialIds.filter(id=>ids.has(id))}))};}
 return out;
}
/** Reviews inspect the draft and independently re-evaluate it; derived projections stay in storage. */
export function draftForModel(result:TopicRecommendationResult){
 return {directions:result.directions.map(({score:_score,...direction})=>direction),assignments:result.assignments};
}
