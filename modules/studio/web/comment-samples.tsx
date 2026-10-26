import type { CreatorContent } from "../contracts";
import { num } from "../../../apps/web/app/features/admin/format";

/** The same saved sample and parent relationships are shown in live and frozen evidence. */
export function CommentSamples({ comments, coverage }: { comments: CreatorContent["comments"]; coverage: CreatorContent["commentCoverage"] | null }) {
  const roots = comments.filter(comment => !comment.parentExternalId), rootIds = new Set(roots.map(comment => comment.externalId));
  const orphaned = comments.filter(comment => comment.parentExternalId && !rootIds.has(comment.parentExternalId));
  const sample = coverage?.replySample;
  const content = (comment: CreatorContent["comments"][number]) => <p>{comment.floor !== undefined && <span className="studio-caption">第 {comment.floor} 楼 · </span>}{comment.text}
    <span className="studio-caption"> · 赞 {comment.likes === null ? "未提供" : num(comment.likes)}</span></p>;
  return <div>
    <p className="studio-caption">已保存 {num(roots.length)} 条一级评论；{coverage?.complete ? "本次一级列表已到末页" : "一级列表未完整，单次最多20条"}。
      {sample ? ` 回复样本 ${num(sample.count)} 条，单次最多${sample.limit}条；${coverage?.repliesComplete ? "所采一级评论下回复已到末页" : "回复尚未完整"}。` : " 本次未保存回复采样范围。"}
      {sample && sample.parentsPending > 0 && ` ${sample.parentsPending} 个已采父评论仍有回复缺口或数量未知。`}样本不代表全部讨论。</p>
    {comments.length ? <ul aria-label="已收录评论">{roots.map(comment => {
      const replies = comments.filter(reply => reply.parentExternalId === comment.externalId);
      return <li key={comment.externalId}>{content(comment)}{!!replies.length && <details><summary>查看回复（{replies.length} 条）</summary>
        <ul>{replies.map(reply => <li key={reply.externalId}>{content(reply)}</li>)}</ul></details>}</li>;
    })}{orphaned.map(comment => <li key={comment.externalId}><span className="studio-caption">回复（父评论未保存）</span>{content(comment)}</li>)}</ul>
      : <p className="studio-caption">本次未取得评论样本。</p>}
  </div>;
}
