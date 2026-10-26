import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { CreatorContents } from "../contracts";
import { creatorMetrics } from "./creator-metrics";
import { MetricHistory } from "./metric-history";
import { CommentSamples } from "./comment-samples";
const date = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong" }) : "尚无记录";

export function CollectedContents({ id }: { id: string }) {
  const [page, setPage] = useState(1), [attempt, retry] = useState(0), [selected, select] = useState(""), [tab, setTab] = useState("content");
  const [data, setData] = useState<CreatorContents | null>(null), [error, setError] = useState(false), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false);
    void fetch(`/api/admin/studio/creators/${id}/contents?page=${page}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as CreatorContents; })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, page, attempt]);
  const post = data?.rows.find(row => row.id === selected) ?? data?.rows[0];
  return <div className="studio-creator-content studio-fixed-panel" aria-busy={loading}>
    <header className="studio-collected-toolbar"><div><h3>作品收录</h3><p className="studio-caption">共 {data?.total ?? 0} 条 · 选择作品查看正文、热度或评论</p></div>
      <button disabled={loading} onClick={() => retry(n => n + 1)}>刷新收录</button></header>
    {error && <p role="alert" className="studio-notice">收录内容未能加载，请检查登录或网络后点击刷新。</p>}
    {!!data?.rows.length && <label className="studio-collected-picker">本页作品<select aria-label="选择收录作品" value={post?.id} disabled={loading} onChange={event => { select(event.target.value); setTab("content"); }}>
      {data.rows.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
    {post && <nav className="studio-tabs" aria-label="作品资料分区">{[["content", "作品内容"], ["metrics", "热度记录"], ["comments", "评论样本"]].map(([key,label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key!)}>{label}</button>)}</nav>}
    <div className="studio-scroll-region studio-collected-reader" role="region" aria-label="作品资料内容" tabIndex={0}>
      {post ? <article key={post.id}><header className="studio-collected-heading"><h3>{post.title}</h3><p className="studio-caption">{{ post: "帖子正文", image_text: "图文笔记", answer: "回答正文", article: "文章正文", video: "视频简介" }[post.kind ?? "video"]} · 发布于 {date(post.publishedAt)}</p>
        <div className="studio-actions"><a href={post.url} target="_blank" rel="noopener noreferrer" className="studio-button">查看原文</a><Link className="studio-button" to={`/admin/studio/intelligence/${encodeURIComponent(`creator:${post.id}`)}`}>完整情报与转写</Link></div></header>
        {tab === "content" && <section aria-label="作品正文"><h4>平台正文与简介</h4><p className="studio-language-sample-body">{post.text || "平台未提供正文或作品简介"}</p>
          {post.parent && <p><a href={post.parent.url} target="_blank" rel="noopener noreferrer">{post.parent.kind === "question" ? "所属问题" : "所属专栏"}：{post.parent.title}</a></p>}
          <h4>最近取得的指标</h4><p className="studio-caption">{creatorMetrics(post.metrics, post.kind)}</p></section>}
        {tab === "metrics" && <section aria-label="作品热度记录"><h4>热度变化与精确记录</h4><MetricHistory observations={post.observations} kind={post.kind} /></section>}
        {tab === "comments" && <section aria-label="作品评论样本"><h4>已收录的评论与回复</h4><CommentSamples comments={post.comments} coverage={post.commentCoverage} /></section>}
      </article> : <p role="status">{loading ? "正在读取收录内容…" : "暂未收录作品，采集成功后会出现在这里。"}</p>}
    </div>
    {(page > 1 || data?.hasMore) && <nav className="studio-pagination studio-fixed-footer" aria-label="收录作品分页"><button disabled={loading || page <= 1} onClick={() => setPage(n => n - 1)}>上一页内容</button><span>第 {page} 页</span><button disabled={loading || !data?.hasMore} onClick={() => setPage(n => n + 1)}>下一页内容</button></nav>}
  </div>;
}
