import { useEffect, useState } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";

type Status = { active: boolean; pendingImageCleanup?: boolean; createdAt: string | null; counts: { sources: number; creators: number; materials: number; batches: number; projects: number } | null };
export function AcceptanceExamples({ active }: { active: boolean }) {
  const action = useAdminAction("studio-layout"), [status, setStatus] = useState<Status | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch("/api/admin/studio/acceptance-examples", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(); const value = await response.json(); if (!controller.signal.aborted) setStatus(value);
    }).catch(() => { if (!controller.signal.aborted) setError("示例状态暂时无法读取，请刷新页面重试。"); });
    return () => controller.abort();
  }, [active]);
  async function change() {
    if (status?.active && !window.confirm("清理本轮所有示例新闻、作者、选题、稿件（含你对这些示例稿的修改）、样本与无引用示例图片？原有来源、Key、Cookie和另建稿件不会直接删除；存在关联时会先提示。需要的示例稿请先导出。")) return;
    const result = await action.run<Status>(status?.active || status?.pendingImageCleanup ? "DELETE" : "POST", "/api/admin/studio/acceptance-examples", {}, { success: status?.active || status?.pendingImageCleanup ? "示例内容已清理" : "示例已载入，五个页面可以直接查看" });
    if (result) { setStatus(result); setError(""); }
  }
  return <section className="studio-session-settings" aria-label="本机验收示例"><h2>本机验收示例</h2>
    <p>示例均为虚构，用来查看完整页面、编辑保存和导出，不代表真实采集、模型生成或审核效果。真实费用与登录状态不会伪造。</p>
    {status && <><p>{status.active ? `已载入：${status.counts!.sources} 个新闻源、${status.counts!.creators} 位作者、${status.counts!.materials} 条材料、${status.counts!.projects} 篇独立稿件。` : "当前没有验收示例。"}</p>
      {status.pendingImageCleanup && <p role="status">示例图片清理待重试，迁移前请完成。</p>}<button disabled={action.busy} onClick={() => void change()}>{action.busy ? "正在处理…" : status.active || status.pendingImageCleanup ? "清理本轮示例数据" : "载入验收示例"}</button></>}
    {error && <p role="alert">{error}</p>}<p className="studio-caption">只允许本项目本机验收数据库，管理时需关闭实际采集与模型调用。正式迁移前清理；另建稿件引用示例时会保护并提示。</p>
  </section>;
}
