import { useState } from "react";
import type { TopicBatch, TopicColumn, TopicDirection, TopicRecommendationResult, TopicRecommendations } from "../contracts";
import { Direction } from "./topic-directions";
import { AdoptTopic } from "./adopt-topic";
import { Dialog } from "./dialog";
import { MaterialDialog } from "./material-dialog";
import { SourceAvatar, externalUrl } from "./material-reading";
import { creatorMetrics } from "./creator-metrics";
import { TopicSupplements, type TopicSupplementScope } from "./topic-supplements";

type References = TopicRecommendations["referenceMaterials"];
const usable = (direction: TopicDirection) => direction.score.eligible && direction.score.total >= 55;

/** The ranking and seven-point analysis are reused; this component only changes how users browse them. */
export function TopicCards({ columns, result, references, batch, reviewed = false, materialPath, pending = false, supplementScope }: {
  columns: TopicColumn[]; result: TopicRecommendationResult | null; references: References; batch?: TopicBatch;
  reviewed?: boolean; materialPath?: (id: string) => string; pending?: boolean; supplementScope?: TopicSupplementScope;
}) {
  const [selected, setSelected] = useState<TopicDirection | null>(null), [reading, setReading] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<TopicDirection | null>(null);
  const [supplementing, setSupplementing] = useState<TopicColumn | null>(null);
  const scope = supplementScope ?? (batch ? { startsAt: batch.startsAt, batchId: batch.id } : null);
  const all = result?.directions ?? [];
  const relatedIds = selected ? new Set([...selected.references.map(ref => ref.materialId),
    ...(result?.assignments.filter(item => item.directionIds.includes(selected.id)).map(item => item.materialId) ?? [])]) : new Set<string>();
  const materials = references.filter(item => relatedIds.has(item.id));
  const creatorIds = new Set(materials.filter(item => item.kind ? item.kind !== "news" : item.id.startsWith("creator:")).map(item => item.source.subject?.id ?? item.source.id));
  const newsCount = materials.filter(item => item.kind === "news" || item.id.startsWith("news:")).length;
  return <>
    <div className="studio-topic-card-grid" aria-label="栏目选题">{columns.filter(column => column.enabled).map(column => {
      const directions = all.filter(direction => direction.columnId === column.id), first = directions.find(usable);
      return <section className="studio-topic-card" key={column.id} aria-label={column.name}>
        <header><h2>{column.name}</h2><span className="studio-caption">{directions.length} 个方向</span></header>
        <p className="studio-topic-card-intro">{column.questions}</p>
        {directions.length ? <ol className="studio-topic-card-directions">{directions.map(direction => <li key={direction.id}>
          <button className="studio-topic-direction-button" onClick={() => setSelected(direction)}>
            <span className="studio-caption">{first?.id === direction.id ? <><svg className="studio-topic-star" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z" fill="currentColor" /></svg> 本栏最推荐</> : usable(direction) ? "可选方向" : "暂不建议"}
              {batch?.adoptedDirectionIds?.includes(direction.id) ? " · 已采纳" : ""}</span>
            <strong>{direction.titles[direction.preferredTitle]}</strong><span>{direction.viewerBenefit}</span>
          </button>
        </li>)}</ol> : <p className="studio-caption studio-topic-card-empty">{pending ? "材料处理中，方向完成后在这里显示。" : result ? "暂无合适方向，不为凑数推荐。" : "尚未生成方向，收集与分析会在后台继续。"}</p>}
        {directions.some(direction => direction.score.gaps.length > 0) && <p className="studio-caption">部分依据尚有缺口，详情中已注明。</p>}
        {scope && <footer className="studio-topic-card-footer"><button type="button" onClick={() => setSupplementing(column)}>增加新闻来源</button></footer>}
      </section>;
    })}</div>
    {selected && <Dialog title={selected.titles[selected.preferredTitle]} onClose={() => { setSelected(null); setReading(null); }} wide>
      <p className="studio-caption">{reviewed ? "本期最终版 · 已完成审核" : "持续更新中 · 截止后统一审核，当前暂不能采纳"} · 相关新闻 {newsCount} 条 · 相关博主 {creatorIds.size} 位</p>
      <p className="studio-caption">目标观众：{batch?.audience ?? "AI 视频、漫剧、影视创作者，偏实操与提效"}</p>
      <div className="studio-topic-detail-layout"><div>
        <Direction direction={selected} references={references} batchId={batch?.id ?? ""} reviewed={reviewed && !!batch} expanded hideReferences
          adopt={() => { setAdopting(selected); setSelected(null); }} />
      </div><aside><details open className="studio-topic-related"><summary>支撑材料与表达参考（{relatedIds.size}）</summary>
        <ul className="studio-batch-list">{materials.map(material => {
          const refs = selected.references.filter(ref => ref.materialId === material.id), original = externalUrl(material.url);
          return <li key={material.id}><div className="studio-material-source"><SourceAvatar source={material.source} /><strong>{material.source.name}</strong></div>
            <h3>{material.title}</h3><p>{material.excerpt || "来源未提供简介，可查看已保存原文。"}</p>
            {refs.map((ref, index) => <p className="studio-caption" key={index}>{ref.role === "expression" ? "表达参考" : ref.role === "counterpoint" ? "反例与限制" : "事实依据"}：{ref.reason}</p>)}
            <p className="studio-caption">{material.metrics ? creatorMetrics(material.metrics, material.kind === "news" ? undefined : material.kind) : "未提供互动指标"}（本版保存值）</p>
            <div className="studio-actions">{materialPath && <button onClick={() => setReading(material.id)}>查看保存的内容</button>}{original && <a href={original} target="_blank" rel="noopener noreferrer">原文链接</a>}</div>
          </li>;
        })}</ul>
        {materials.length < relatedIds.size && <p className="studio-caption">部分引用暂不可读，请保留原链接，不使用当前材料替换旧依据。</p>}
      </details></aside></div>
      {reading && materialPath && <MaterialDialog key={reading} id={reading} snapshotPath={materialPath(reading)} onClose={() => setReading(null)} />}
    </Dialog>}
    {adopting && batch && <AdoptTopic key={adopting.id} batch={batch} directions={all} references={references} initial={adopting} onClose={() => setAdopting(null)} />}
    {supplementing && scope && <TopicSupplements key={`${scope.startsAt}:${supplementing.id}`} scope={scope} column={supplementing} onClose={() => setSupplementing(null)} />}
  </>;
}
