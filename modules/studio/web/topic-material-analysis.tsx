import { useState } from "react";
import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { num } from "../../../apps/web/app/features/admin/format";
import type { TopicColumn, TopicMaterialAnalysis, TopicMaterialAnalysisPage } from "../contracts";
import { materialDispositions } from "./topic-material-labels";
import { MaterialInsightsEvidence } from "./material-insights";

const states = { not_analyzed: "待分析", queued: "已排队", running: "分析中", completed: "已分析", failed: "分析未完成" };
const dimensions = { audience: "受众相关", practical: "实用价值", evidence: "证据", freshness: "时效", demand: "需求信号", distinctiveness: "差异化" };

export function MaterialAnalysisControls({ batchId, page }: { batchId: string; page: TopicMaterialAnalysisPage }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  const [message, setMessage] = useState("");
  async function submit() {
    setMessage("");
    const result = await action.run<{ queuedCount: number }>("POST", `/api/admin/studio/topic-batches/${batchId}/analysis`, { retryFailed: true });
    if (result) setMessage(result.queuedCount ? `已提交 ${num(result.queuedCount)} 条材料，后台继续分析。` : "没有新增任务；已排队或自动重试中的任务会继续执行。");
  }
  return <section className="studio-material-analysis-controls" aria-labelledby="material-analysis-title">
    <div><h2 id="material-analysis-title">材料归类与初筛</h2>
      <p className="studio-caption">分析就绪 {num(page.analyzed)} 条 · 待处理 {num(page.pending)} 条。初筛分用于后续综合，不代表最终选题排名。</p></div>
    <div className="studio-actions"><button className="studio-primary" disabled={action.busy || !page.modelEnabled || !page.pending} onClick={submit}>{action.busy ? "正在提交…" : "补齐分析与重试"}</button>
      <button disabled={action.busy} onClick={() => revalidator.revalidate()}>刷新分析进度</button></div>
    <p className="studio-caption">{page.modelEnabled ? "仅处理未完成项，保留已完成结果；需后台任务服务运行。" : "模型调用已关闭；先在服务端配置模型并启用，再运行后台任务。"}</p>
    <p className="studio-caption" role="status">{message}</p>
  </section>;
}

export function MaterialAnalysisSummary({ item, columns }: { item: TopicMaterialAnalysis | undefined; columns: TopicColumn[] }) {
  if (!item || item.state === "not_analyzed") return <span className="studio-caption">待分析</span>;
  const column = columns.find(column => column.id === item.columnId);
  return <span className="studio-caption">{states[item.state]}{column ? ` · ${column.name}` : ""}{item.disposition ? ` · ${materialDispositions[item.disposition]}` : ""}
    {item.score ? ` · 初筛 ${num(item.score.total, 1)} / 100` : ""}</span>;
}

export function MaterialAnalysisEvidence({ item }: { item: TopicMaterialAnalysis | undefined }) {
  if (!item) return <MaterialInsightsEvidence />;
  const gaps = [...new Set([...(item.gaps ?? []), ...(item.score?.gaps ?? [])])];
  return <section className="studio-material-analysis-evidence" aria-label="材料初筛说明">
    {item.error && <p className="studio-notice">{item.error}</p>}
    {item.summary && <p>{item.summary}</p>}
    {item.reason && <p className="studio-caption">判断依据：{item.reason}</p>}
    {item.viewerBenefit && <p className="studio-caption">观看收益：{item.viewerBenefit}</p>}
    {item.score && <p className="studio-caption">{item.score.eligible ? "可参与后续综合，仍需跨材料核对与审核。" : "暂不作为合格候选，保留归类与依据。"}</p>}
    {gaps.length > 0 && <p className="studio-caption">信息缺口：{gaps.join("；")}。</p>}
    {item.score && <details><summary>查看评分与原文依据</summary>
      <dl className="studio-analysis-dimensions">{Object.entries(dimensions).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{item.score!.dimensions[key as keyof typeof dimensions] === null ? "未知" : num(item.score!.dimensions[key as keyof typeof dimensions]!)}</dd></div>)}</dl>
      {item.evidenceQuotes?.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}
      <p className="studio-caption">评分口径：{item.score.policyVersion}。未知项保留缺口，不向其他维度补分。</p>
    </details>}
    <MaterialInsightsEvidence insights={item.insights} />
  </section>;
}
