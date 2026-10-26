import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { MaterialAnalysisReading, MaterialAnalysisState, TopicMaterialAnalysis } from "../contracts";
import { MaterialAnalysisEvidence } from "./topic-material-analysis";

const labels: Record<MaterialAnalysisState | "not_connected", string> = {
  not_connected: "初筛待安排", not_analyzed: "初筛待安排", pending: "初筛待安排", waiting_body: "初筛等待完整正文",
  queued: "初筛已排队", running: "初筛处理中", completed: "初筛已完成", failed: "初筛需重试", superseded: "初筛已交由批次处理",
};
export const initialAnalysisLabel = (state: MaterialAnalysisState | "not_connected") => labels[state];
const classificationLabels: Partial<Record<MaterialAnalysisState, string>> = { pending: "等待后台更新", queued: "已排队", running: "正在更新",
  completed: "已按当前标准更新", failed: "更新未完成，可重试", superseded: "已等待新标准处理" };

/** Live reading is an explicit opt-in; frozen evidence readers never mount this component. */
export function MaterialAnalysisReadingPanel({ materialId, initial }: { materialId: string; initial: MaterialAnalysisReading | null }) {
  const [reading, setReading] = useState(initial), [readFailed, setReadFailed] = useState(false);
  const [changed, setChanged] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null), alive = useRef(true);
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  const sourceKey = initial?.sourceKey ?? null;
  const classificationState = reading?.classification?.state;
  const refresh = useCallback(async () => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy(true); const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/admin/studio/intelligence/${encodeURIComponent(materialId)}/analysis`, {
        signal: controller.signal, cache: "no-store", credentials: "same-origin",
      });
      if (!response.ok) throw new Error("reading unavailable");
      const next: MaterialAnalysisReading = await response.json();
      if (next.materialId !== materialId || !(next.state in labels)) throw new Error("invalid identity or state");
      if (alive.current && !controller.signal.aborted) {
        if (next.sourceKey !== sourceKey || ["completed", "failed", "superseded"].includes(next.state)) setMessage("");
        if (next.sourceKey !== sourceKey) setChanged(true);
        else { setReading(next); setReadFailed(false); }
      }
    } catch { if (alive.current && pending.current === controller) setReadFailed(true); }
    finally { clearTimeout(deadline); if (alive.current && pending.current === controller) { setBusy(false); pending.current = null; } }
  }, [materialId, sourceKey]);
  useEffect(() => {
    if (changed || !reading?.modelEnabled || ![reading.state, classificationState].some(state => state && ["pending", "waiting_body", "queued", "running"].includes(state))) return;
    const timer = setInterval(() => { if (!document.hidden && !pending.current) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [changed, reading?.state, classificationState, reading?.modelEnabled, refresh]);
  async function retry(classification = false) {
    setMessage("");
    const result = await action.run<{ queued: boolean }>("POST", `/api/admin/studio/intelligence/${encodeURIComponent(materialId)}/${classification ? "classification" : "analysis"}`, {}, { revalidate: false });
    if (result && alive.current) { setMessage(result.queued ? "已提交重试，后台继续处理。" : "任务已安排，没有重复提交。"); await refresh(); }
  }
  const result: TopicMaterialAnalysis | undefined = !changed && reading?.state === "completed" && reading.result
    ? { ...reading.result, materialId, state: "completed", receiptId: reading.receiptId, error: reading.error } : undefined;
  return <section className="studio-material-analysis-controls" aria-label="已保存的材料初筛">
    <h3>材料初筛</h3>
    {changed ? <><p className="studio-notice">内容已更新，请刷新这条情报后查看对应分析。</p>
      <button disabled={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}>刷新情报</button></>
      : <><p role="status">{initialAnalysisLabel(reading?.state ?? "not_analyzed")}</p>
        {reading?.result?.columnSnapshot && <p className="studio-caption">{classificationState === "completed" ? "当前栏目" : "分析时栏目"}：{reading.result.columnSnapshot.name} · 版本 {reading.result.columnSnapshot.version}</p>}
        {classificationState && <p className="studio-caption" role="status">栏目匹配：{classificationLabels[classificationState] ?? "等待处理"}。{classificationState !== "completed" && "已有结果保留，后台处理后更新。"}</p>}
        <p className="studio-caption">{classificationState === "completed" ? "当前分类已更新，所属批次仍保留归档版本。" : reading?.origin === "batch" ? "读取所属批次保存的同版分析。" : "读取采集后保存的初筛。"}初筛供后续综合使用，最终选题需跨材料核对与审核。</p>
        <MaterialAnalysisEvidence item={result} />
        {reading?.error && reading.state !== "completed" && <p className="studio-notice">{reading.error}</p>}
        {reading?.classification?.error && classificationState === "failed" && <p className="studio-notice">{reading.classification.error}</p>}
        {readFailed && <p className="studio-caption" role="alert">分析状态暂时无法读取，已保存的正文和结果仍保留，可重试刷新。</p>}
        {!reading?.modelEnabled && (reading?.state !== "completed" || classificationState && classificationState !== "completed") && <p className="studio-caption">模型调用已暂停，已有记录仍可查看。</p>}
        <div className="studio-actions"><button disabled={busy || action.busy} onClick={() => void refresh()}>{busy ? "正在刷新…" : "刷新分析状态"}</button>
          {reading?.state === "failed" && !reading.batchOwnsVersion && reading.modelEnabled && <button disabled={busy || action.busy} onClick={() => void retry()}>{action.busy ? "正在提交…" : "重试材料分析"}</button>}
          {classificationState === "failed" && reading?.modelEnabled && <button disabled={busy || action.busy} onClick={() => void retry(true)}>{action.busy ? "正在提交…" : "重试栏目匹配"}</button>}
          {reading?.batchId && <Link to={`/admin/studio/topics/batches/${encodeURIComponent(reading.batchId)}`}>{reading.batchOwnsVersion ? "前往所属批次" : "查看归档版本"}</Link>}</div>
        {reading?.batchOwnsVersion && reading.state === "failed" && <p className="studio-caption">同版材料已由批次接管，请在所属批次补齐分析与重试。</p>}
        {message && <p className="studio-caption" role="status">{message}</p>}</>}
  </section>;
}
