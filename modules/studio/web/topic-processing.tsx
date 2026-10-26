import { useState } from "react";
import { PanelDialog } from "./panel-dialog";
import { BatchTimeline } from "./batch-timeline";
import { Link, useSearchParams } from "react-router";
import type { loadTopicProcessing } from "./topic-processing.server";
import type { CurrentTopicPreview, TopicBatch, TopicBatchPage, TopicMaterialPage, TopicMaterialAnalysisPage, TopicRecommendations, TopicReview } from "../contracts";
import { MaterialEvidence } from "./material-reading";
import { TopicRuleText } from "./topic-rule-text";
import { MaterialAnalysisControls, MaterialAnalysisSummary, MaterialAnalysisEvidence } from "./topic-material-analysis";
import { TopicDirections } from "./topic-directions";
import { TopicReviewPanel } from "./topic-review";
import { TopicBackground } from "./topic-history";
import { initialAnalysisLabel } from "./material-analysis-reading";
import { TopicSourceCoverage } from "./topic-source-coverage";
import { TopicRuleVersions } from "./topic-rule-versions";
import { TopicPreview } from "./topic-preview";
import { TopicTabs } from "./topic-tabs";
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const date = (value: string) => clock.format(new Date(value));
function Pages({ page, hasMore, history = false }: { page: number; hasMore: boolean; history?: boolean }) {
  const [search] = useSearchParams();
  const url = (target: number) => { const query = new URLSearchParams(search); query.set("materialPage", String(target)); return `?${query}`; };
  return <nav className="studio-pagination" aria-label={history ? "批次分页" : "批次材料分页"}>
    {page > 1 && <Link to={url(page - 1)}>上一页</Link>}<span>第 {page} 页</span>{hasMore && <Link to={url(page + 1)}>下一页</Link>}
  </nav>;
}
function Materials({ list, snapshot, analysis, columns = [] }: { list: TopicMaterialPage; snapshot: boolean; analysis?: TopicMaterialAnalysisPage; columns?: TopicBatch["columns"] }) {
  const results = new Map(analysis?.rows.map(row => [row.materialId, row]));
  return <section className="studio-batch-materials" aria-label={snapshot ? "冻结材料" : "当期材料"}>
    <h2>{snapshot ? "本期材料快照" : "已收录的当期材料"}</h2>
    <p className="studio-caption">{snapshot ? "正文、来源名称和实际指标保留冻结时的版本。" : "这里是持续更新的预览，尚未冻结。"} 内容在下方直接展示，正文较多时可在中间区域滚动。</p>
    {list.rows.length ? <ul className="studio-batch-list">{list.rows.map(item => <li key={item.id}>
      <details className="studio-batch-material"><summary><span className="studio-caption">{item.source.name} · {item.freshness === "background" ? "背景材料" : item.freshness === "undated" ? "发布日期待核实" : "本期新发布"}{item.arrivedLate ? " · 迟到补收" : ""}</span>
        <span className="studio-batch-material-title">{item.title}</span><span className="studio-material-excerpt">{item.excerpt || "来源暂无简介，展开查看已保存内容。"}</span>
        {snapshot ? <MaterialAnalysisSummary item={results.get(item.id)} columns={columns} /> : <span className="studio-caption">{initialAnalysisLabel(item.analysisState)}</span>}</summary>
        <MaterialEvidence item={item} snapshot={snapshot} analysis={snapshot ? <MaterialAnalysisEvidence item={results.get(item.id)} /> : undefined} />
        {!snapshot && <p><Link to={`/admin/studio/intelligence/${encodeURIComponent(item.id)}`}>查看情报与初筛分析</Link></p>}
        <p className="studio-caption">{snapshot ? "冻结收录时间" : "收录时间"}：{date(item.collectedAt)} · {item.kind === "news" ? `原文版本 ${item.contentVersion.revision ?? "未提供"}` : "博主内容指纹已保存"}</p>
      </details>
    </li>)}</ul> : <div className="studio-empty"><h3>{list.total ? "这一页暂无材料" : snapshot ? "这一批没有已冻结材料" : "本期还没有收录材料"}</h3>
      <p className="studio-caption">{snapshot ? "空快照不代表所有来源均已检查成功。" : "可到关注管理配置来源；采集开关和登录状态需分别检查。"}</p><Link to="/admin/studio/following">前往关注管理</Link></div>}
    <Pages page={list.page} hasMore={list.hasMore} />
  </section>;
}
function Rules({ columns }: { columns: TopicBatch["columns"] }) {
  return <details className="studio-batch-rules"><summary>查看本批次保存的栏目规则</summary>
    <ul className="studio-batch-list">{columns.map(column => <li key={column.id}><h3>{column.name} · 版本 {column.version}</h3>
      <p className="studio-caption">{column.enabled ? "当时已启用" : "当时已停用"} · 每期最多 {column.maxDirections} 个方向</p>
      <TopicRuleText column={column} />
    </li>)}</ul>
  </details>;
}


export function TopicProcessingSettings({ data }: { data: Awaited<ReturnType<typeof loadTopicProcessing>> }) {
  const [open,setOpen] = useState(false), [choosing, setChoosing] = useState(false);
  const panels = data.view === "current" ? [
    {id:"overview",label:"期次概览",content:<section><h2>正在收集的当期</h2><p>{data.preview.materialCount}条材料 · {data.preview.stage === "collecting" ? "收集中" : "待开始"}</p></section>},
    {id:"coverage",label:"来源检查与分页缺口",content:<TopicSourceCoverage key="current-coverage" />},
    {id:"materials",label:"已收录的当期材料",content:<Materials list={data.materials} snapshot={false} />},
  ] : [
    {id:"overview",label:"期次概览",content:<section><h2>{date(data.batch.startsAt)} — {date(data.batch.endsAt)}</h2><p>{data.batch.materialCount}条材料 · 冻结于{date(data.batch.frozenAt)}</p><p>{data.review.state === "completed" ? "审核已完成" : "待处理或处理中"}</p></section>},
    {id:"coverage",label:"来源检查与分页缺口",content:<TopicSourceCoverage key={data.batch.id} batchId={data.batch.id} />},
    {id:"materials",label:"已收录的当期材料",content:<Materials list={data.materials} snapshot analysis={data.analysis} columns={data.batch.columns} />},
    {id:"review",label:"审核与处理",content:<><TopicReviewPanel batch={data.batch} page={data.review} draft={data.recommendations} /><MaterialAnalysisControls batchId={data.batch.id} page={data.analysis} /></>},
    {id:"draft",label:"候选方向初版",content:<TopicDirections batch={data.batch} page={data.recommendations} />},
    {id:"rules",label:"本期栏目及版本",content:<><TopicRuleVersions batch={data.batch} /><Rules columns={data.batch.columns} /></>},
    {id:"background",label:"历史关联",content:<TopicBackground batchId={data.batch.id} />},
  ];
  return <section className="studio-processing-screen" aria-label="选题处理状态"><h2>选题处理状态</h2>
    <div className="studio-actions studio-period-choice"><button onClick={()=>setChoosing(true)}>检查期次</button><span className="studio-caption" title={data.view === "frozen" ? date(data.batch.startsAt) : "正在收集的当期"}>{data.view === "frozen" ? date(data.batch.startsAt) : "正在收集的当期"}</span><button onClick={()=>setOpen(true)}>查看状态</button></div>
    {choosing && <PanelDialog title="选择检查期次" onClose={()=>setChoosing(false)} panels={[
      {id:"current",label:"正在收集当期",content:<Link className="studio-button" to="/admin/studio/settings/processing" onClick={()=>setChoosing(false)}>选择正在收集的当期</Link>},
      {id:"history",label:"历史期次",content:<div className="studio-period-history" onClickCapture={event=>{if((event.target as HTMLElement).closest("a"))setChoosing(false);}}><BatchTimeline initial={data.list} selected={data.view === "frozen" ? data.batch.id : null} href={id=>`/admin/studio/settings/processing?batch=${id}`} /></div>},
    ]} />}
    {data.view === "current" && <TopicPreview key={data.preview.startsAt} preview={data.preview} />}
    {open && <PanelDialog title="检查期次" onClose={() => setOpen(false)} panels={panels} />}
  </section>;
}
