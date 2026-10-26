import { useEffect, useRef, useState } from "react";
import type { TopicFeedback } from "../contracts";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";

/** A direction's explicit preference, separate from adopting it or its frozen score. */
export function TopicFeedbackEditor({ batchId, directionId }: { batchId: string; directionId: string }) {
  const url = `/api/admin/studio/topic-batches/${encodeURIComponent(batchId)}/directions/${encodeURIComponent(directionId)}/feedback`;
  const action = useAdminAction("studio-layout"), request = useRef<AbortController | null>(null);
  const [saved, setSaved] = useState<TopicFeedback | null>(null), [rating, setRating] = useState<TopicFeedback["rating"]>(null);
  const [reason, setReason] = useState(""), [loading, setLoading] = useState(false), [message, setMessage] = useState("");
  const busy = loading || action.busy, dirty = !!saved && (rating !== saved.rating || reason !== saved.reason);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  function accept(value: TopicFeedback) { setSaved(value); setRating(value.rating); setReason(value.reason); }
  async function load() {
    if (dirty && !window.confirm("刷新会丢弃这条选题尚未保存的反馈，是否继续？")) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setMessage(""); const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const result: { feedback: TopicFeedback } = await response.json();
      if (request.current === controller) accept(result.feedback);
    } catch { if (request.current === controller) setMessage("反馈未能读取，请刷新重试；当前编辑仍保留。"); }
    finally { clearTimeout(deadline); if (request.current === controller) { setLoading(false); request.current = null; } }
  }
  async function save() {
    if (!saved) return;
    setMessage("");
    const result = await action.run<{ feedback: TopicFeedback }>("PUT", url, { version: saved.version, rating, reason }, { revalidate: false });
    if (result) { accept(result.feedback); setMessage(result.feedback.rating ? "反馈已保存，将供后续批次参考。" : "反馈已撤回，后续批次不再使用这条评价。"); }
    else setMessage("反馈尚未保存，编辑仍保留。若提示版本冲突，请先刷新反馈再修改。");
  }
  return <details className="studio-batch-rules" onToggle={event => { if (event.currentTarget.open && !saved && !busy) void load(); }}>
    <summary>选题反馈</summary>
    <p className="studio-caption">只影响后续相近问题的排序，最多调整正负 3 分；未采纳不算差评，已保存的选题与稿件保持当时版本。</p>
    {saved && <fieldset disabled={busy} className="studio-form"><legend>这个方向是否适合你</legend>
      <label>评价<select aria-label="评价" value={rating ?? ""} onChange={event => setRating(event.target.value ? event.target.value as TopicFeedback["rating"] : null)}>
        <option value="">未评价 / 撤回评价</option><option value="useful">有用，希望继续推荐相近问题</option><option value="not_useful">不适合，减少相近角度</option>
      </select></label>
      <label>原因（可选）<textarea aria-label="原因（可选）" rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：步骤可演示，或这个问题对我的制作流程帮助不大" /></label>
    </fieldset>}
    <div className="studio-actions"><button type="button" disabled={busy || !saved || !dirty} onClick={() => void save()}>{action.busy ? "正在保存…" : "保存反馈"}</button>
      <button type="button" disabled={busy} onClick={() => void load()}>{loading ? "正在读取…" : "刷新反馈"}</button></div>
    <p className="studio-caption" role="status">{message}</p>
  </details>;
}
