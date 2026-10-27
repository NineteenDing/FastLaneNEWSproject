import {useState} from 'react';import {useRevalidator} from 'react-router';
import {useAdminAction} from '../../../apps/web/app/features/admin/action';import type {TopicGapReport} from '../contracts';
export function TopicGapPanel({batchId,initial}:{batchId:string;initial:TopicGapReport}){
 const [page,setPage]=useState<TopicGapReport|null>(null),[reading,setReading]=useState(false);const report=page??initial;
 const action=useAdminAction('studio-layout'),revalidator=useRevalidator();
 async function load(value:number){setReading(true);try{const response=await fetch(`/api/admin/studio/topic-batches/${batchId}/gaps?page=${value}`);if(response.ok)setPage(await response.json());}finally{setReading(false);}}
 async function retry(materialId:string,mode:'analysis'|'body'){const result=await action.run('POST',`/api/admin/studio/topic-batches/${batchId}/recover-material`,{materialId,mode},{success:mode==='body'?'已提交正文重取；新正文供后续处理，已出刊选题不改写':'已提交一次材料初筛'});if(result){setPage(null);void revalidator.revalidate();}}
 return <section className="studio-session-settings mt-6 rounded-2xl border border-line p-5" aria-labelledby="topic-gaps-title"><h2 id="topic-gaps-title">本期材料处理报告</h2>
 <p>{report.total} 条材料 · {report.completed} 条已完成初筛 · {report.used} 条纳入本版选题 · {report.unanalysed} 条尚未完成分析</p>
 <p className="studio-caption">失败或缺正文不会阻断本期出刊。这里保留未完成原因，可手动恢复；恢复结果不覆盖已生成的正式选题。</p>
 {report.rows.length?<ul className="studio-material-list" style={{maxHeight:440,overflowY:'auto'}}>{report.rows.map(row=><li className="border-b border-line py-4" key={row.materialId}>
 <strong className="block text-sm leading-6">{row.title}</strong><p className="studio-caption">{row.reason}</p><div className="studio-actions mt-2">
 {row.canFetchBody?<button disabled={action.busy} onClick={()=>void retry(row.materialId,'body')}>重新获取新闻正文</button>
 :<button disabled={action.busy||row.state==='running'||row.state==='queued'} onClick={()=>void retry(row.materialId,'analysis')}>重新提交初筛</button>}
 </div></li>)}</ul>:<p className="studio-caption">本期材料没有未完成分析项。</p>}
 {(report.page>1||report.hasMore)&&<nav className="studio-pagination" aria-label="未完成材料分页"><button disabled={reading||report.page<=1} onClick={()=>void load(report.page-1)}>上一页</button><span>第{report.page}页</span><button disabled={reading||!report.hasMore} onClick={()=>void load(report.page+1)}>下一页</button></nav>}
 </section>;
}
