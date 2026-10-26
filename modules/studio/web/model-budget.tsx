import { useState, type FormEvent } from "react";
import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { ModelBudgetSettings } from "../contracts";

export function ModelBudgetForm({ settings }: { settings: ModelBudgetSettings }) {
  const action = useAdminAction("studio-layout"), refresh = useRevalidator();
  const [perDay, setPerDay] = useState(String(settings.perDay)), [perMonth, setPerMonth] = useState(String(settings.perMonth));
  const [hardLimitEnabled, setHardLimitEnabled] = useState(settings.hardLimitEnabled);
  const [warningPerDay, setWarningPerDay] = useState(String(settings.warningPerDay)), [warningPerMonth, setWarningPerMonth] = useState(String(settings.warningPerMonth));
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run("PUT", "/api/admin/studio/model-budget", { version: settings.version, perDay: Number(perDay), perMonth: Number(perMonth), hardLimitEnabled,
      warningPerDay: Number(warningPerDay), warningPerMonth: Number(warningPerMonth) }, { success: "费用提醒与硬预算已保存，用量保持不变" });
  }
  function reload() {
    if ((Number(perDay) !== settings.perDay || Number(perMonth) !== settings.perMonth || hardLimitEnabled !== settings.hardLimitEnabled
      || Number(warningPerDay) !== settings.warningPerDay || Number(warningPerMonth) !== settings.warningPerMonth)
      && !window.confirm("刷新会放弃尚未保存的预算修改，继续吗？")) return;
    setPerDay(String(settings.perDay)); setPerMonth(String(settings.perMonth)); setHardLimitEnabled(settings.hardLimitEnabled);
    setWarningPerDay(String(settings.warningPerDay)); setWarningPerMonth(String(settings.warningPerMonth)); refresh.revalidate();
  }
  return <form className="studio-model-form studio-budget-form" aria-label="模型预算设置" onSubmit={save}>
    <h3 className="studio-wide">费用提醒与硬预算</h3>
    <label>每日提醒（元）<input type="number" min={0} max={1_000_000} step="any" required value={warningPerDay} onChange={event => setWarningPerDay(event.target.value)} disabled={action.busy} /></label>
    <label>每月提醒（元）<input type="number" min={0} max={1_000_000} step="any" required value={warningPerMonth} onChange={event => setWarningPerMonth(event.target.value)} disabled={action.busy} /></label>
    <p className="studio-caption studio-wide">达到提醒金额仍会继续处理任务。默认每日10元、每月200元，仅作本机估算提醒。</p>
    <div className="studio-actions studio-wide"><span id="hard-budget-label">启用硬预算</span><button type="button" className="studio-slide-switch" role="switch" aria-labelledby="hard-budget-label" aria-checked={hardLimitEnabled} disabled={action.busy} onClick={() => setHardLimitEnabled(value => !value)}><span aria-hidden="true" /></button></div>
    <label>每日上限（元）<input type="number" min={0} max={1_000_000} step="any" required={hardLimitEnabled} value={perDay} onChange={event => setPerDay(event.target.value)} disabled={action.busy || !hardLimitEnabled} /></label>
    <label>每月上限（元）<input type="number" min={0} max={1_000_000} step="any" required={hardLimitEnabled} value={perMonth} onChange={event => setPerMonth(event.target.value)} disabled={action.busy || !hardLimitEnabled} /></label>
    <p className="studio-caption studio-wide">按香港时间累计。只有开启硬预算才按日/月上限停止新请求，开启时0元即阻止新收费请求；关闭后上限不生效。保存不会清零用量或改变模型开关，已开始的单次请求可完成。已有明确设置的旧上限会保留启用状态。</p>
    <div className="studio-actions studio-wide"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存费用设置"}</button>
      <button type="button" disabled={action.busy || refresh.state !== "idle"} onClick={reload}>刷新预算设置</button></div>
  </form>;
}
