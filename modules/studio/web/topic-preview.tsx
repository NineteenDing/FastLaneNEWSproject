import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { CurrentTopicPreview } from "../contracts";
import { TopicDirectionColumns } from "./topic-directions";
import { TopicRuleText } from "./topic-rule-text";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const states = { not_generated: "尚未生成", queued: "已排队", running: "正在综合材料", draft: "草案已保存", failed: "生成未完成" };

export function TopicPreview({ preview }: { preview: CurrentTopicPreview }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator(), [message, setMessage] = useState("");
  const running = preview.state === "queued" || preview.state === "running";
  const disabled = action.busy || running || !preview.modelEnabled || preview.stage !== "collecting" || !preview.materialCount;
  async function submit(retryFailed = false) {
    setMessage("");
    const result = await action.run<{ queued: boolean }>("POST", "/api/admin/studio/topic-batches/current/preview", {
      startsAt: preview.startsAt, ...(retryFailed ? { retryFailed: true } : {}),
    });
    if (result) setMessage(result.queued ? "候选草案已提交，后台处理；可刷新查看进度。" : "已有结果或任务，未重复生成。");
  }
  return <section className="studio-topic-directions" aria-labelledby="topic-preview-title">
    <h2 id="topic-preview-title">候选方向草案</h2>
    <p className="studio-caption">{states[preview.state]} · 尚未审核。先看创作方向；截止后的完整综合与两轮审核结果在历史批次查看。</p>
    <div className="studio-actions">
      {preview.state === "failed" ? <><button className="studio-primary" disabled={disabled} onClick={() => submit(true)}>重试原草案</button>
        {preview.stale && <button disabled={disabled || !!preview.inputIssue} onClick={() => submit()}>按最新材料更新</button>}</>
        : <button className="studio-primary" disabled={disabled || !!preview.inputIssue || (!!preview.result && !preview.stale)} onClick={() => submit()}>
          {action.busy ? "正在提交…" : preview.result ? "更新候选草案" : "生成候选草案"}</button>}
      <button disabled={action.busy} onClick={() => revalidator.revalidate()}>刷新草案进度</button>
    </div>
    {!preview.modelEnabled && <p className="studio-caption">模型调用尚未启用。可在<Link to="/admin/studio/settings">设置</Link>配置；已保存草案仍可查看。</p>}
    {preview.stale && <p className="studio-notice" role="status">材料、指标或栏目规则已有变化。以下保留生成时的依据；更新后再查看，当前草案不能直接采纳。</p>}
    {preview.error && <p className="studio-notice" role="alert">{preview.error}</p>}
    {preview.inputIssue && <p className="studio-notice" role="alert">{preview.inputIssue}</p>}
    {message && <p className="studio-caption" role="status">{message}</p>}
    {preview.capturedAt && <p className="studio-caption">草案版本 {preview.version} · 依据保存于 {clock.format(new Date(preview.capturedAt))} · 纳入 {preview.includedMaterialCount} 条完整正文或转写。
      {preview.generatedAt && <> 生成于 {clock.format(new Date(preview.generatedAt))}。</>} 当前未纳入的待处理材料仍在下方列表，不表示已经全部筛完。</p>}
    {preview.result && preview.columns && <TopicDirectionColumns columns={preview.columns} result={preview.result} references={preview.referenceMaterials ?? []} />}
    {preview.columns && <details className="studio-batch-rules"><summary>查看草案使用的栏目规则</summary>
      <ul className="studio-batch-list">{preview.columns.map(column => <li key={column.id}><h3>{column.name} · 版本 {column.version}</h3><TopicRuleText column={column} /></li>)}</ul>
    </details>}
    {!preview.result && !running && <p className="studio-caption">准备好正文后可生成跨材料的候选方向。不为凑数强行推荐，未完成转写的内容暂不纳入。</p>}
    <p className="studio-caption">启用两日计划、后台与模型后，每5分钟检查准备好的材料；15分钟内的新变化合并处理，相同依据不重复生成。更新时保留上一版栏目选题，完成后替换；刷新页面只读取已保存结果。</p>
  </section>;
}
