import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { TopicHistoryPage, WritingProject } from "../contracts";
import { MaterialEvidence } from "./intelligence";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const originalDate = (value: string | null) => value ? clock.format(new Date(value)) : "未提供";

export function HistoryChanges({ changes }: { changes?: WritingProject["historyChanges"] }) {
  if (!changes || !changes.policyChanged && !changes.changedMaterialIds.length) return null;
  return <p className="studio-notice" role="status">{changes.changedMaterialIds.length > 0 && `${changes.changedMaterialIds.length} 条背景来源已变化或不再可检索。`}
    {changes.policyChanged && "历史检索规则已更新。"} 请核对当前情报；这里保留当时证据，不会自动改写选题或稿件。</p>;
}

export function HistoryCitation({ item }: { item: NonNullable<WritingProject["snapshot"]["history"]>["items"][number] }) {
  return <><p className="studio-caption">背景关联：{item.reason}</p>
    <details aria-label="采用的历史引文位置"><summary>查看采用的引文位置（{item.anchors.length}）</summary>
      {item.anchors.length ? item.anchors.map((anchor, index) => <div key={index}><p className="studio-caption">{anchor.kind === "video"
        ? `原转写 ${anchor.startSeconds}–${anchor.endSeconds} 秒（原视频可能已清理）` : `原文第 ${anchor.paragraph} 段`}</p><blockquote>{anchor.quote}</blockquote></div>)
        : <p className="studio-caption">本材料没有记录方向采用的逐字引文，可核对下方完整快照。</p>}
    </details></>;
}

export function TopicBackground({ batchId }: { batchId: string }) {
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; result?: TopicHistoryPage; error?: string; loading: boolean } | null>(null);
  const current = response?.key === batchId ? response : null, report = current?.result;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResponse(old => ({ key: batchId, loading: true, result: old?.key === batchId ? old.result : undefined }));
    void (async () => {
      try {
        const result = await fetch(`/api/admin/studio/topic-batches/${encodeURIComponent(batchId)}/history`, { credentials: "same-origin", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!result.ok) throw new Error("unavailable");
        const data = await result.json() as TopicHistoryPage;
        if (!controller.signal.aborted) setResponse({ key: batchId, result: data, loading: false });
      } catch {
        if (!controller.signal.aborted) setResponse(old => ({ key: batchId, loading: false, result: old?.key === batchId ? old.result : undefined,
          error: "背景资料暂时无法读取，请重试；本期选题和材料仍可查看。" }));
      }
    })();
    return () => controller.abort();
  }, [open, batchId, retry]);
  return <details className="studio-batch-rules" aria-label="历史背景关联" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>背景关联 · 查看历史资料</summary>
    <p className="studio-caption">用于对照历史条件，不计入本期新增数量。完整正文按需展开，读取不会重新生成选题。</p>
    <div className="studio-actions"><button type="button" disabled={current?.loading} onClick={() => setRetry(value => value + 1)}>刷新背景资料</button></div>
    {open && (!current || current.loading) && <p className="studio-caption" role="status">正在读取背景资料…</p>}
    {current?.error && <p className="studio-notice" role="alert">{current.error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试背景加载</button></p>}
    {report?.state === "not_prepared" && <p className="studio-caption">本批次尚无历史关联记录；旧批次不会在阅读时补写，新的综合任务会准备背景资料。</p>}
    {report?.state === "ready" && <><HistoryChanges changes={report} />
      <p className="studio-caption">本批次保存 {report.items.length} 条背景 · 候选上限 {report.candidateLimit}，完整证据上限 {report.evidenceLimit} · 香港时间。</p>
      {report.coverage === "incremental_only" && <p className="studio-caption">历史索引尚未完成存量补建，当前关联可能不全。</p>}
      {report.omittedQueryTerms > 0 && <p className="studio-caption">本期超出检索词预算 {report.omittedQueryTerms} 项，部分背景可能未召回。</p>}
      {report.items.length ? <ul className="studio-batch-list">{report.items.map(({ material, reason }) => <li key={material.id}><details className="studio-batch-material">
        <summary><span className="studio-caption">{material.source.name} · 历史背景 · 原始发布：{originalDate(material.publishedAt)}</span>
          <span className="studio-batch-material-title">{material.title}</span><span className="studio-material-excerpt">{reason}</span></summary>
        {report.changedMaterialIds.includes(material.id) && <p className="studio-notice">此来源已变化或不再可检索；以下仍为当时快照。</p>}
        <p className="studio-caption">原文版本 {material.contentVersion.revision ?? "指纹已保存"} · 收录于 {originalDate(material.collectedAt)}</p>
        <MaterialEvidence item={material} snapshot />
        <Link to={`/admin/studio/intelligence/${encodeURIComponent(material.id)}`} target="_blank" rel="noopener noreferrer">另页核对当前情报</Link>
      </details></li>)}</ul> : <p className="studio-caption">本批次没有召回相关背景，仍可按本期材料判断；不代表全库没有相关资料。</p>}
    </>}
  </details>;
}
