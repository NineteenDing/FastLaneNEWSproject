import { useEffect, useRef, useState } from "react";
import type { ModelBudgetSettings, ModelUsage } from "../contracts";
import { ModelBudgetForm } from "./model-budget";

const money = (value: number) => value > 0 && value < 0.0001 ? "不足 ¥0.0001" : new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);
const count = (value: number) => new Intl.NumberFormat("zh-CN").format(value);

export function ModelUsageSettings({ usage, budget }: { usage: ModelUsage; budget: ModelBudgetSettings }) {
  const [latest, setLatest] = useState<ModelUsage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), report = latest ?? usage;
  useEffect(() => {
    active.current?.abort(); active.current = null; setLatest(null); setBusy(false); setError("");
    return () => { active.current?.abort(); };
  }, [usage]);
  async function refresh() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/studio/model-usage", { credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error();
      const result = await response.json() as ModelUsage;
      if (active.current === controller && !controller.signal.aborted) setLatest(result);
    } catch { if (!controller.signal.aborted) setError("用量暂时无法读取，已保留上次数据，请重试。"); }
    finally { if (active.current === controller && !controller.signal.aborted) { active.current = null; setBusy(false); } }
  }
  return <section className="studio-model-usage" aria-label="模型费用与用量">
    <h3>费用与用量</h3>
    {(report.budget.warningToday || report.budget.warningThisMonth) && <p className="studio-notice" role="status">已达到{report.budget.warningToday ? "每日" : ""}{report.budget.warningToday && report.budget.warningThisMonth ? "和" : ""}{report.budget.warningThisMonth ? "每月" : ""}费用提醒。{report.budget.hardLimitEnabled ? "硬预算按下方上限执行。" : "硬预算未启用，任务继续处理。"}</p>}
    <ModelBudgetForm key={budget.version} settings={budget} />
    <div className="studio-actions"><p className="studio-caption">{report.day} · 香港时间</p>
      <button type="button" onClick={refresh} disabled={busy}>{busy ? "正在刷新…" : "刷新用量"}</button></div>
    {error && <p className="studio-notice" role="alert">{error}</p>}
    <p>今日预算占用 {money(report.budget.spentToday)}；本月 {money(report.budget.spentThisMonth)}。{report.budget.hardLimitEnabled ? `硬上限：每日 ${money(report.budget.perDay)}，每月 ${money(report.budget.perMonth)}。` : "硬预算未启用。"}</p>
    <p className="studio-caption">预算占用包含费用估算及在途、用量缺失或结果不明的预留，实际扣费以服务商账单为准。复用已保存答案不重复计费。</p>
    <p className="studio-caption">执行位占用 {report.concurrency.occupied} / {report.concurrency.limit}；创作待办 {report.tasks.queued}，执行或等待中的任务 {report.tasks.active}。
      {!report.modelEnabled ? " 模型未启用，待办保留。" : report.concurrency.occupied >= report.concurrency.limit ? " 执行位已满，后续请求等候。" : " 后台仍按资源和预算限制执行。"}</p>
    <ul className="studio-usage-list">{report.rows.map(row => <li key={row.key}>
      <h4>{row.label}</h4><dl>
        <div><dt>本月请求尝试</dt><dd>{count(row.attemptsThisMonth)}</dd></div>
        <div><dt>本月已记录输入 / 输出 tokens</dt><dd>{count(row.inputTokensThisMonth)} / {count(row.outputTokensThisMonth)}</dd></div>
        <div><dt>今日 / 本月费用估算</dt><dd>{money(row.estimatedToday)} / {money(row.estimatedThisMonth)}</dd></div>
        <div><dt>今日 / 本月预留</dt><dd>{money(row.reservedToday)} / {money(row.reservedThisMonth)}</dd></div>
      </dl>
      {(row.missingUsageAttempts > 0 || row.unknownAttempts > 0) && <p className="studio-caption">本月 {row.missingUsageAttempts} 次未取得完整用量，{row.unknownAttempts} 次结果不明；未记录的 tokens 不按零消耗解释。</p>}
    </li>)}</ul>
    <p className="studio-caption">尝试次数包含失败或未发送的请求，复用不新增尝试。费用为本机估算，服务商账户余额与最终账单请在服务商后台核对。</p>
  </section>;
}
