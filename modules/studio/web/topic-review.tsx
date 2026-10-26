import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicBatch, TopicReview, TopicRecommendations } from "../contracts";
import { TopicDirectionList } from "./topic-directions";

const states = { not_started: "审核未开始", queued: "审核已排队", running: "正在审核与修订", failed: "审核未完成", completed: "审核流程已完成" };
const decisions = { accept: "采纳", partial: "部分采纳", reject: "不采纳" };
const severity = { blocking: "必须处理", major: "重要问题", minor: "改进建议" };

function revealDirection(id: string) {
  let element = document.getElementById(id);
  const summary = element?.querySelector("summary");
  while (element) { if (element instanceof HTMLDetailsElement) element.open = true; element = element.parentElement; }
  summary?.focus({ preventScroll: true });
}

export function TopicReviewPanel({ batch, page, draft }: { batch: TopicBatch; page: TopicReview; draft: TopicRecommendations }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator(), [message, setMessage] = useState("");
  const running = ["queued", "running"].includes(page.state);
  const verdict = page.verdict === "passed" ? "审核通过" : page.verdict === "revised" ? "已完成两轮审核并修订" : page.verdict === "no_materials" ? "无材料，无需模型审核" : states[page.state];
  async function submit() {
    setMessage("");
    const result = await action.run<{ queued: boolean }>("POST", `/api/admin/studio/topic-batches/${batch.id}/review`, { retryFailed: true });
    if (result) setMessage(result.queued ? "审核任务已提交，后台会自动完成审核与修订。" : "无需新建任务，已有结果或进行中的任务会保留。");
  }
  return <section className="studio-topic-directions" aria-labelledby="topic-review-title">
    <h2 id="topic-review-title">自动审核</h2><p>{verdict}</p>
    {page.summary && <p>{page.summary}</p>}
    <p className="studio-caption">最多两轮独立审核；未通过时自动汇总意见、裁决并修订。已保存 {page.completedSteps} 个处理步骤，重试会复用成功步骤。</p>
    <div className="studio-actions"><button className="studio-primary" disabled={action.busy || !page.modelEnabled || !draft.result || running || page.state === "completed"} onClick={submit}>
      {action.busy ? "正在提交…" : page.state === "failed" ? "重试未完成审核" : "开始自动审核"}</button>
      <button disabled={action.busy} onClick={() => revalidator.revalidate()}>刷新审核进度</button></div>
    {!draft.result && <p className="studio-caption">初版生成后再开始审核；后台任务启用时会自动接续。</p>}
    {!page.modelEnabled && <p className="studio-caption">模型调用尚未启用，已保存的意见与结果仍可查看。</p>}
    {page.error && <p className="studio-notice" role="alert">{page.error}</p>}<p className="studio-caption" role="status">{message}</p>
    {page.rounds.length > 0 && <details className="studio-batch-rules"><summary>查看审核记录（{page.rounds.length} 轮）</summary>
      <ul className="studio-batch-list">{page.rounds.map(round => <li key={round.round}><h3>第 {round.round} 轮 · {round.passed ? "通过" : "需修改"}</h3>
        <p>{round.summary}</p>{round.opinions.map(opinion => <details key={opinion.id}><summary>{severity[opinion.severity]}：{opinion.problem}</summary>
          <p>{opinion.suggestion}</p><div className="studio-actions">{opinion.directionIds.map(id => {
            const final = page.result?.directions.find(direction => direction.id === id), direction = final ?? draft.result?.directions.find(item => item.id === id);
            if (!direction) return <span key={id}>方向已在修订中移除：{id}</span>;
            const target = `topic-${final ? "final" : "draft"}-${id}`;
            return <a key={id} href={`#${target}`} onClick={() => revealDirection(target)}>关联方向：{direction.titles[direction.preferredTitle]}{final ? "" : "（初版）"}</a>;
          })}{opinion.materialIds.map(id => <Link key={id} to={`/admin/studio/intelligence/${encodeURIComponent(id)}`}>查看关联材料</Link>)}</div>
        </details>)}</li>)}</ul>
    </details>}
    {page.decisions.length > 0 && <details className="studio-batch-rules"><summary>查看意见采纳与修改（{page.decisions.length} 项）</summary><ul className="studio-batch-list">
      {page.decisions.map(item => <li key={item.opinionId}><strong>{decisions[item.decision]}：{page.rounds.flatMap(round => round.opinions).find(opinion => opinion.id === item.opinionId)?.problem ?? "审核意见"}</strong><p>{item.reason}</p></li>)}
    </ul></details>}
    {page.result && page.verdict !== "no_materials" && <section className="studio-topic-directions" aria-labelledby="topic-final-title"><h2 id="topic-final-title">最终选题推荐</h2>
      <p className="studio-caption">按栏目查看方向、标题和来源；采纳后建立独立稿件，同批次可以写多篇。</p>
      <TopicDirectionList batch={batch} result={page.result} references={page.referenceMaterials} reviewed />
    </section>}
  </section>;
}
