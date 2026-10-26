import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicPlan } from "../contracts";

export function TopicPlanSettings({ plan }: { plan: TopicPlan }) {
  const action = useAdminAction("studio-layout");
  const [form, setForm] = useState(() => ({ version: plan.version, enabled: plan.enabled,
    start: new Date(Date.parse(plan.startsAt) + 8 * 3600_000).toISOString().slice(0, 16) }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run<TopicPlan>("PUT", "/api/admin/studio/topic-plan", {
      version: form.version, enabled: form.enabled, startsAt: plan.anchorLocked ? plan.startsAt : new Date(form.start + ":00+08:00").toISOString(),
    }, { success: "选题计划已保存" });
    if (result) setForm(current => ({ ...current, version: result.version }));
  }
  return <section className="studio-session-settings" aria-labelledby="topic-plan-title">
    <h2 id="topic-plan-title">两日选题计划</h2>
    <p className="studio-caption">到截止点保存材料快照；每次处理一期，停机后按先后顺序补收。资源不足时等待恢复。</p>
    <div className="studio-session-row"><div><h3>{plan.enabled ? "自动截止已开启" : "自动截止已关闭"}</h3>
      <p className="studio-caption">固定 48 小时，香港时间。后台任务服务运行后才会执行。</p>
      <Link to="/admin/studio/topics">查看当期与历史</Link>
    </div><form onSubmit={save}>
      <label className="studio-plan-toggle" htmlFor="topic-plan-enabled"><input id="topic-plan-enabled" type="checkbox" checked={form.enabled}
        disabled={action.busy} onChange={event => setForm({ ...form, enabled: event.target.checked })} />启用自动截止</label>
      <label htmlFor="topic-plan-start">首批开始时间（香港时间）</label>
      <input id="topic-plan-start" type="datetime-local" step="60" required value={form.start} disabled={action.busy || plan.anchorLocked}
        onChange={event => setForm({ ...form, start: event.target.value })} aria-describedby="topic-plan-help" />
      <p id="topic-plan-help" className="studio-caption">{plan.anchorLocked
        ? "已有历史批次，当前版本锁定时间边界；仍可暂停或恢复自动截止。历史内容保持原样。"
        : "首批在开始后 48 小时截止，后续首尾相接。首次冻结前可调整起点。"}</p>
      <div className="studio-actions"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存选题计划"}</button></div>
    </form></div>
    <p className="studio-notice">保存计划不会开启采集或模型开关。模型调用已启用且后台运行时，会对冻结材料归类、综合选题，并自动进行最多两轮审核及意见裁决。</p>
  </section>;
}
