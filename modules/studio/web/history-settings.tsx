import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { HistorySettings } from "../contracts";

const fields = (value: HistorySettings) => ({ version: value.version, candidates: String(value.candidateLimit), evidence: String(value.evidenceLimit) });
export function HistorySettingsForm({ settings }: { settings: HistorySettings }) {
  const action = useAdminAction("studio-layout"), [form, setForm] = useState(() => fields(settings)), [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false), request = useRef<AbortController | null>(null), saved = useRef(fields(settings));
  useEffect(() => () => request.current?.abort(), []);
  async function save(event: FormEvent) {
    event.preventDefault(); setMessage("");
    const result = await action.run<HistorySettings>("PUT", "/api/admin/studio/history-settings", {
      version: form.version, candidateLimit: Number(form.candidates), evidenceLimit: Number(form.evidence),
    }, { success: "历史关联数量已保存，只影响新提交的综合任务", revalidate: false });
    if (result) { saved.current = fields(result); setForm(saved.current); setMessage("已保存；排队任务、旧批次和稿件保持原有数量与证据。"); }
    else setMessage("数量未保存，输入已保留。若其他窗口已修改，请重新载入最新数量后再保存。");
  }
  async function refresh() {
    if (JSON.stringify(form) !== JSON.stringify(saved.current) && !window.confirm("重新载入会放弃此处未保存的数量修改；其他设置保留。是否继续？")) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setMessage("");
    try {
      const response = await fetch("/api/admin/studio/history-settings", { credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as HistorySettings;
      if (!controller.signal.aborted) { saved.current = fields(result); setForm(saved.current); setMessage("已载入最新数量，其他设置保持不变。"); }
    } catch { if (!controller.signal.aborted) setMessage("最新数量暂时无法读取，当前输入已保留，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const busy = loading || action.busy;
  return <section className="studio-session-settings" aria-labelledby="history-settings-title"><h2 id="history-settings-title">历史背景关联</h2>
    <p className="studio-caption">先从索引找候选，再读取少量完整正文。默认 50 条候选、10 条完整证据；减少数量可降低处理量，也可能遗漏背景。</p>
    <div className="studio-session-row"><div><h3>新任务的召回数量</h3><p className="studio-caption">当前编辑版本 {form.version}。只影响此后新提交的综合任务，不改变排队任务或旧稿，也不会开启采集或模型。</p></div>
      <form onSubmit={save}><label htmlFor="history-candidates">历史候选上限（1–50）</label>
        <input id="history-candidates" type="number" min="1" max="50" step="1" required value={form.candidates} disabled={busy}
          onChange={event => setForm({ ...form, candidates: event.target.value })} />
        <label htmlFor="history-evidence">完整背景证据上限（1–10）</label>
        <input id="history-evidence" type="number" min="1" max={Math.min(10, Number(form.candidates) || 10)} step="1" required value={form.evidence} disabled={busy}
          onChange={event => setForm({ ...form, evidence: event.target.value })} aria-describedby="history-settings-help" />
        <p className="studio-caption" id="history-settings-help">完整证据数量不能超过候选数量。原日期、出处与全文随批次保存。</p>
        <div className="studio-actions"><button className="studio-primary" disabled={busy}>{action.busy ? "正在保存…" : "保存历史数量"}</button>
          <button type="button" disabled={busy} onClick={() => void refresh()}>{loading ? "正在读取…" : "重新载入历史数量"}</button></div>
        <p className="studio-caption" role="status">{message}</p>
      </form></div>
  </section>;
}
