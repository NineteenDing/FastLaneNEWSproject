import {z} from 'zod';import {sql} from '@aihot/backend/db';import {Conflict} from '@aihot/backend/audit';
import {enqueue,QUEUES} from '@aihot/backend/jobs/queue';import {batchEvidence} from './topic-evidence.ts';
import {submitTopicAnalysis} from './topic-material-analysis.ts';import {historyEvidenceKey} from './history-entities.ts';
import type {TopicBatchMaterial,TopicGapReport,TopicRecommendationResult,DirectionRankingContext} from '../contracts.ts';
export async function topicGapReport(batchId:string,input:unknown={}):Promise<TopicGapReport>{
 z.uuid().parse(batchId);const q=z.object({page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().parse(input);
 return sql.begin('isolation level repeatable read read only',async db=>{
 const rows=await db<Array<{id:string;material:TopicBatchMaterial;state:string;result:Record<string,any>|null;error:string|null}>>`
 SELECT m.material_id AS id,m.evidence AS material,coalesce(a.state,'not_analyzed') AS state,a.result,a.error
 FROM (${batchEvidence(db,batchId)}) m LEFT JOIN studio_topic_material_analyses a ON a.batch_id=${batchId} AND a.material_id=m.material_id ORDER BY m.collected_at,m.material_id`;
 const completed=rows.filter(r=>r.state==='completed'&&r.result!==null).length,missing=rows.filter(r=>r.state!=='completed'||!r.result);
 const [recommendation]=await db<{context:DirectionRankingContext|null;result:unknown}[]>`SELECT ranking_context AS context,result FROM studio_topic_recommendations WHERE batch_id=${batchId}`;
 let fallback:TopicGapReport['fallback'];
 if(!recommendation?.result){
 const [preview]=await db<any[]>`SELECT p.result,p.input FROM studio_topic_previews p JOIN studio_topic_batches b ON b.starts_at=p.starts_at WHERE b.id=${batchId}`;
 const result:TopicRecommendationResult|undefined=preview?.result??preview?.input.previous?.result,materials:TopicBatchMaterial[]|undefined=preview?.result?preview?.input.materials:preview?.input.previous?.input.materials;
 if(result&&materials?.every(old=>rows.some(row=>row.id===old.id&&historyEvidenceKey(row.material)===historyEvidenceKey(old))))
  fallback={result,referenceMaterials:materials.map(({id,title,url,source,excerpt,kind,publishedAt})=>({id,title,url,source,excerpt,kind,publishedAt}))};
 }
 const shown=missing.slice((q.page-1)*20,q.page*20).map(row=>{
  const bodyMissing=!row.material.body.trim()||!['ok','collected','transcribed'].includes(row.material.bodyState);
  return{materialId:row.id,title:row.result?.shared?.titleZh??row.material.title,state:row.state,
   reason:bodyMissing?'正文或转写未取得，未纳入本版选题':row.state==='failed'?(row.error??'模型输出未通过校验'):row.state==='running'?'截止时分析仍在进行':'截止时分析尚未完成',canFetchBody:row.id.startsWith('news:')&&bodyMissing};
 });
 return{total:rows.length,completed,unanalysed:missing.length,used:recommendation?.context?.materialIds?.length??0,page:q.page,hasMore:q.page*20<missing.length,rows:shown,...(fallback?{fallback}:{})};
 });
}
export async function recoverTopicMaterial(batchId:string,input:unknown,actor:string){
 z.uuid().parse(batchId);const q=z.object({materialId:z.string().max(100).regex(/^(news|creator):[A-Za-z0-9_-]+$/),mode:z.enum(['analysis','body'])}).strict().parse(input);
 const [row]=await sql<{evidence:TopicBatchMaterial}[]>`SELECT evidence FROM (${batchEvidence(sql,batchId)}) m WHERE m.material_id=${q.materialId}`;
 if(!row)throw new Conflict('材料不属于这个批次');
 if(q.mode==='analysis')return submitTopicAnalysis(batchId,actor,{retryFailed:true,materialIds:[q.materialId]});
 if(!q.materialId.startsWith('news:'))throw new Conflict('博主视频请在对应材料中重新转写');
 const articleId=q.materialId.slice(5);
 return sql.begin(async db=>{
  const changed=await db`UPDATE articles SET body_status='pending',processing_error=NULL,processing_retry_at=NULL WHERE id=${articleId} AND body_status<>'ok' RETURNING id`;
  if(!changed.length)return{queued:false};
  const id=await enqueue(QUEUES.extractBody,{articleId},{singletonKey:'manual-body:'+articleId,retryLimit:0},db);
  return{queued:!!id};
 });
}
