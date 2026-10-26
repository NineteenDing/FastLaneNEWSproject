import { useState } from "react";
import type { TopicBatchMaterial, WritingProject } from "../contracts";
import { SourceAvatar, externalUrl } from "./material-reading";
import { MaterialDialog } from "./material-dialog";
import { creatorMetrics } from "./creator-metrics";
import { HistoryCitation } from "./topic-history";

const platforms = { news: "新闻", bilibili: "B站", weibo: "微博", xhs: "小红书", zhihu: "知乎", tieba: "贴吧", douyin: "抖音", kuaishou: "快手" };
const kinds = { news: "新闻", video: "视频", post: "帖子", image_text: "图文", answer: "回答", article: "文章" };
const names = { views: "播放", likes: "点赞/赞同", comments: "评论", reposts: "分享", favorites: "收藏" };

/** Only rank comparable saved counters within their own platform and content type. */
export function WritingReferences({ project }: { project: WritingProject }) {
  const [query, setQuery] = useState(""), [reading, setReading] = useState<TopicBatchMaterial | null>(null);
  const grouped = new Map<string, TopicBatchMaterial[]>();
  for (const material of project.snapshot.materials) {
    const key = `${material.source.platform}:${material.kind}`; grouped.set(key, [...(grouped.get(key) ?? []), material]);
  }
  const value = query.trim().toLocaleLowerCase();
  return <section className="studio-writing-references" aria-label="本稿全部引用"><h2>本稿全部引用</h2>
    <label>搜索本稿参考<input maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="作者、标题、正文关键词" /></label>
    <p className="studio-caption">同平台同类型按保存的指标排序；不同发布时间仅供参考，不加总跨平台热度。</p>
    <div className="studio-writing-reference-scroll" tabIndex={0} role="region" aria-label="引用内容列表">
    {[...grouped].map(([key, items]) => {
      const metric = items[0]!.kind === "news" ? undefined : ([items[0]!.kind === "video" ? "views" : "likes", "likes", "comments", "favorites", "reposts"] as const)
        .find(metric => items.some(item => typeof item.metrics?.[metric] === "number"));
      const shown = [...items].sort((a, b) => metric ? (b.metrics?.[metric] ?? -1) - (a.metrics?.[metric] ?? -1) : 0)
        .filter(item => !value || `${item.source.name} ${item.title} ${item.body}`.toLocaleLowerCase().includes(value));
      if (!shown.length) return null;
      return <div key={key}><h3>{platforms[items[0]!.source.platform]} · {kinds[items[0]!.kind]}{metric ? ` · 按${names[metric]}` : " · 未提供可比较指标"}</h3>
        <ul>{shown.map(item => { const original = externalUrl(item.url), history = project.snapshot.history?.items.find(ref => ref.materialId === item.id);
          return <li key={item.id}><div className="studio-material-source"><SourceAvatar source={item.source} /><strong>{item.source.name}</strong></div>
            <button type="button" className="studio-writing-reference-title" onClick={() => setReading(item)}>{item.title}</button>
            <p className="studio-caption">{item.excerpt || "暂无简介，点击查看保存正文。"}</p>
            <p className="studio-caption">{item.metrics ? creatorMetrics(item.metrics, item.kind === "news" ? undefined : item.kind) : "未提供互动指标"}</p>
            <p className="studio-caption">{item.publishedAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(item.publishedAt)) : "原发布时间未知"} · {project.snapshot.references.filter(ref => ref.materialId === item.id).map(ref => ({ fact: "事实依据", expression: "表达参考", counterpoint: "反例与限制" })[ref.role]).join(" / ")}{history ? " · 历史背景" : ""}</p>
            {original && <a href={original} target="_blank" rel="noopener noreferrer">原文链接</a>}{history && <details><summary>历史关联依据</summary><HistoryCitation item={history} /></details>}
          </li>;
        })}</ul></div>;
    })}
    {value && !project.snapshot.materials.some(item => `${item.source.name} ${item.title} ${item.body}`.toLocaleLowerCase().includes(value)) && <p className="studio-caption">没有匹配引用，可换个关键词。</p>}
    </div>
    {reading && <MaterialDialog key={reading.id} id={reading.id} snapshot={reading} onClose={() => setReading(null)} />}
  </section>;
}

export function WritingBrief({ project }: { project: WritingProject }) {
  const references = project.snapshot.materials.filter(item => project.snapshot.references.some(ref => ref.materialId === item.id && ref.role === "expression"));
  const sources = [...new Map(references.map(item => [item.source.subject?.id ?? item.source.id, item.source])).values()];
  return <section className="studio-writing-brief" aria-label="本稿创作要点"><p className="studio-caption">受众：{project.snapshot.audience}</p>
    <div className="studio-writing-expression-avatars"><span className="studio-caption">表达参考</span>{sources.length ? sources.map(source => <span key={source.id} className="studio-material-source"><SourceAvatar source={source} />{source.name}</span>) : <span className="studio-caption">未选具体表达作品，按本稿写作规则起草。</span>}</div>
    <details><summary>方向、理由与重点（{project.snapshot.directions.length}）</summary>{project.snapshot.directions.map(direction => <div key={direction.id}>
      <h3>{project.snapshot.columns.find(column => column.id === direction.columnId)?.name} · {direction.question}</h3><p>{direction.viewerBenefit}</p><p className="studio-caption">为什么做：{direction.whyNow}</p>
      <p className="studio-caption">制作重点：{direction.usage.steps.join(" → ")}；{direction.usage.limitations.join("；")}</p>
    </div>)}</details>
  </section>;
}
