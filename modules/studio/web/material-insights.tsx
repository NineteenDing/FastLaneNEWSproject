import type { MaterialInsights } from "../contracts";
import { num } from "../../../apps/web/app/features/admin/format";

export function MaterialInsightsEvidence({ insights }: { insights?: MaterialInsights }) {
  if (!insights) return <section aria-label="评论与影响分析"><h3>评论关注点与可能影响</h3>
    <p className="studio-caption">这次分析尚未保存评论关注点与影响判断，保留原文和实际评论供查看。</p></section>;
  const sample = insights.commentSample;
  return <section className="studio-material-analysis-evidence" aria-label="评论与影响分析">
    <h3>评论关注点</h3>
    {sample.count === 0 ? <p className="studio-caption">未取得评论样本，不能判断评论倾向。</p> : <>
      <p className="studio-caption">仅基于已收录的 {num(sample.count)} 条评论样本；{sample.complete ? "本次一级评论列表已到末页" : "本次未取得完整一级评论列表"}。{sample.repliesComplete ? "回复列表已到末页。" : "回复未完整采集。"}不代表平台全部用户。</p>
      {insights.commentFocus.length ? <ul>{insights.commentFocus.map((theme, index) => <li key={index}><p>{theme.point}</p>
        <details><summary>查看评论依据</summary>{theme.evidence.map((citation, citationIndex) => <blockquote key={citationIndex}>
          {citation.quote}<p className="studio-caption">评论编号：{citation.commentId}</p></blockquote>)}</details></li>)}</ul>
        : <p className="studio-caption">本次样本尚未形成明确的关注点。</p>}
    </>}
    <h3>可能影响</h3>
    {insights.impacts.length ? <ul>{insights.impacts.map((impact, index) => <li key={index}>
      <p><strong>{impact.kind === "reported" ? "原文陈述" : "推断"}：</strong>{impact.effect}</p>
      <p className="studio-caption">适用条件与限制：{impact.conditions}</p>
      <details><summary>查看影响依据</summary>{impact.evidenceQuotes.map((quote, quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</details>
    </li>)}</ul> : <p className="studio-caption">当前材料不足以形成有依据的影响判断。</p>}
  </section>;
}
