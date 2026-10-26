import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { num } from "../../../apps/web/app/features/admin/format";
import type { TopicBatch, TopicColumn, TopicDirection, TopicRecommendations, TopicRecommendationResult } from "../contracts";
import { externalUrl, SourceAvatar } from "./intelligence";
import { materialDispositions } from "./topic-material-labels";
import { AdoptTopic } from "./adopt-topic";
import { TopicFeedbackEditor } from "./topic-feedback";

const states = { not_generated: "初版尚未生成", queued: "生成任务已排队", running: "正在综合材料", draft: "初版已保存 · 审核未开始", failed: "生成未完成" };
const roles = { fact: "事实依据", expression: "表达参考", counterpoint: "反例与限制" };

export function Direction({ batchId, direction, references, reviewed, adopt, expanded = false, hideReferences = false }: { batchId: string; direction: TopicDirection; references: TopicRecommendations["referenceMaterials"]; reviewed: boolean; adopt(): void; expanded?: boolean; hideReferences?: boolean }) {
  const label = !direction.score.eligible || direction.score.total < 55 ? "暂不建议" : direction.score.total >= 70 ? "优先候选" : "可选方向";
  const expression = direction.references.filter(ref => ref.role === "expression").flatMap(ref => {
    const material = references.find(item => item.id === ref.materialId); return material ? [{ref, material}] : [];
  }).filter((item, index, items) => items.findIndex(other => other.material.id === item.material.id) === index);
  return <details className={`studio-direction${expanded ? " studio-direction-expanded" : ""}`} open={expanded || undefined} id={expanded ? undefined : `topic-${reviewed ? "final" : "draft"}-${direction.id}`}>
    <summary><span className="studio-caption">{label} · {reviewed ? "方向分" : "初版方向分"} {num(direction.score.total, 1)} / 100</span>
      <span className="studio-batch-material-title">{direction.titles[direction.preferredTitle]}</span><span className="studio-material-excerpt">{direction.viewerBenefit}</span></summary>
    {expression.length ? <ul className="studio-batch-list" aria-label="建议学习的表达参考">{expression.slice(0, 3).map(({ref, material}) => {
      const original = externalUrl(material.url);
      return <li key={material.id}><div className="studio-material-source"><SourceAvatar source={material.source} /><div><strong>{material.source.name}</strong>
        <p>{original ? <a href={original} target="_blank" rel="noopener noreferrer">{material.title}</a> : material.title}</p><p className="studio-caption">学习方式：{ref.reason}</p></div></div></li>;
    })}</ul> : <p className="studio-caption">尚未指定具体表达样本，可在采纳时补充；不会仅凭作者姓名声称已学习。</p>}
    {expression.length > 3 && <p className="studio-caption">先展示3条表达参考，其余 {expression.length - 3} 条在下方支撑材料中查看。</p>}
    <dl className="studio-direction-brief">
      <div><dt>观众问题与收益</dt><dd>{direction.question} {direction.viewerBenefit}</dd></div>
      <div><dt>为什么现在</dt><dd>{direction.whyNow}</dd></div>
      <div><dt>推荐切入点</dt><dd>{direction.angle}</dd></div>
      <div><dt>如何使用</dt><dd><ol>{direction.usage.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        {direction.usage.conditions.length > 0 && <p>适用条件：{direction.usage.conditions.join("；")}</p>}
        {direction.usage.limitations.length > 0 && <p>限制：{direction.usage.limitations.join("；")}</p>}</dd></div>
      <div><dt>标题建议</dt><dd><ul>{direction.titles.map((title, index) => <li key={index}>{title}{index === direction.preferredTitle ? "（首选）" : ""}</li>)}</ul></dd></div>
      <div><dt>建议表达结构</dt><dd><p>开头：{direction.structure.opening}</p><p>节奏：{direction.structure.rhythm}</p><p>结尾：{direction.structure.ending}</p></dd></div>
    </dl>
    {!hideReferences && <details className="studio-direction-references"><summary>支撑材料与表达参考（{direction.references.length}）</summary>
      <ul className="studio-batch-list">{direction.references.map((ref, index) => {
        const material = references.find(item => item.id === ref.materialId), original = externalUrl(material?.url ?? null);
        return <li key={index}>{material ? <><div className="studio-material-source"><SourceAvatar source={material.source} /><div><strong>{material.source.name}</strong><p className="studio-caption">{roles[ref.role]}</p></div></div>
          <h4>{material.title}</h4><p>{ref.reason}</p><blockquote>{ref.quote}</blockquote>
          <div className="studio-actions">{original && <a href={original} target="_blank" rel="noopener noreferrer">查看来源原文</a>}
            <Link to={`/admin/studio/intelligence/${encodeURIComponent(material.id)}`}>查看当前情报</Link></div></> : <p>引用材料暂不可用：{ref.materialId}</p>}</li>;
      })}</ul>
    </details>}
    {direction.score.gaps.length > 0 && <p className="studio-caption">信息缺口：{direction.score.gaps.join("；")}。</p>}
    {direction.score.ranking && <details className="studio-batch-rules"><summary>查看评分与排序依据</summary>
      {direction.score.configured && <><p>规则版本 {direction.score.configured.policyVersion}，各维度贡献：</p><dl className="studio-component-list">
        {Object.entries({ heat: "传播热度", freshness: "时效变化", impact: "行业影响", practical: "实用价值", evidence: "事实证据", distinctiveness: "差异化" }).map(([key, name]) =>
          <div key={key}><dt>{name}</dt><dd>{num(direction.score.configured!.contributions[key as keyof typeof direction.score.configured.contributions], 2)} 分</dd></div>)}
      </dl></>}
      <p>六维基础分 {num(direction.score.ranking.baseTotal, 2)}；{!direction.score.configured && <>时效调整 {num(direction.score.ranking.timeAdjustment, 2)}；</>}来源或重复角度调整 {num(direction.score.ranking.diversityAdjustment, 2)}；最终 {num(direction.score.total, 2)} 分。</p>
      {direction.score.ranking.preferenceAdjustment !== undefined && <p className="studio-caption">明确反馈调整 {num(direction.score.ranking.preferenceAdjustment, 2)} 分，匹配 {direction.score.ranking.feedbackMatches ?? 0} 条同栏目反馈。单次反馈影响有限，事实与受众门槛仍须满足。</p>}
      {direction.score.ranking.adoptionAdjustment !== undefined && <p className="studio-caption">往期采用角度调整 {num(direction.score.ranking.adoptionAdjustment, 2)} 分。
        {direction.score.ranking.previousProjectId && <>同栏目已有相同事件与角度，当前事实引文未增加：<Link to={`/admin/studio/writing/${direction.score.ranking.previousProjectId}`}>查看往期稿件</Link>。</>}
        只比较少量近期采用记录；有新引文不代表已核实有新进展，仍由本轮材料审核判断。</p>}
      <p className="studio-caption">{direction.score.configured ? "热度与事件时效由程序计算；冻结批次沿用提交时版本，收集中的方向按当前观察重排。未知依据不补分。" : "以批次截止时间计算，历史阅读不重新变分。时效只调整时效维度；其他实用与证据分不因内容较旧而扣除。缺少需求依据不会补成满分。"}来源与重复角度在当前栏目内比较，同属一个栏目不扣分。</p>
    </details>}
    {reviewed && <div className="studio-actions"><button className="studio-primary" onClick={adopt}>采纳并写稿</button></div>}
    {reviewed && <TopicFeedbackEditor key={`${batchId}:${direction.id}`} batchId={batchId} directionId={direction.id} />}
  </details>;
}

export function TopicDirectionColumns({ columns, result, references, batchId = "", reviewed = false, onAdopt = () => {} }: {
  columns: TopicColumn[]; result: TopicRecommendationResult; references: TopicRecommendations["referenceMaterials"];
  batchId?: string; reviewed?: boolean; onAdopt?: (direction: TopicDirection) => void;
}) {
  return <div className="studio-direction-columns">{columns.filter(column => column.enabled).map(column => {
    const directions = result.directions.filter(direction => direction.columnId === column.id), materials = result.assignments.filter(item => item.columnId === column.id);
    return <details className="studio-direction-column" key={column.id}><summary><span>{column.name}</span><span className="studio-caption">{directions.length} 个方向 · {materials.length} 条材料</span></summary>
      {directions.length ? directions.map(direction => <Direction key={direction.id} batchId={batchId} direction={direction} references={references} reviewed={reviewed} adopt={() => onAdopt(direction)} />) : <p className="studio-caption">本栏没有形成方向，不为填满数量凑选题。</p>}
      <details className="studio-direction-assignments"><summary>本栏全部材料去向（{materials.length}）</summary><ul>{materials.map(item => <li key={item.materialId}>
        <Link to={`/admin/studio/intelligence/${encodeURIComponent(item.materialId)}`}>{references.find(material => material.id === item.materialId)?.title ?? "查看材料"}</Link>
        <span> · {materialDispositions[item.disposition]}：{item.reason}</span></li>)}</ul></details>
    </details>;
  })}</div>;
}

export function TopicDirectionList({ batch, result, references, reviewed = false }: { batch: TopicBatch; result: TopicRecommendationResult;
  references: TopicRecommendations["referenceMaterials"]; reviewed?: boolean }) {
  const [adopting, setAdopting] = useState<TopicDirection | null>(null);
  return <><TopicDirectionColumns columns={batch.columns} batchId={batch.id} result={result} references={references} reviewed={reviewed} onAdopt={setAdopting} />
    {adopting && <AdoptTopic key={adopting.id} batch={batch} directions={result.directions} references={references} initial={adopting} onClose={() => setAdopting(null)} />}</>;
}

export function TopicDirections({ batch, page }: { batch: TopicBatch; page: TopicRecommendations }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator(), [message, setMessage] = useState("");
  const running = ["queued", "running"].includes(page.state);
  async function generate() {
    setMessage("");
    const result = await action.run<{ queued: boolean }>("POST", `/api/admin/studio/topic-batches/${batch.id}/recommendations`, { retryFailed: true });
    if (result) setMessage(result.queued ? "生成任务已提交，后台会继续处理。" : "没有新建任务，已保存或进行中的结果会保留。");
  }
  return <section className="studio-topic-directions" aria-labelledby="topic-direction-title">
    <h2 id="topic-direction-title">综合选题初版</h2><p className="studio-caption">{page.reviewState === "not_started" ? `${states[page.state]}。当前为初步建议，尚未审核，暂不能采纳写稿。` : "这里保留生成时的初版；审核进度与最终结果见自动审核区。"}</p>
    <div className="studio-actions"><button className="studio-primary" disabled={action.busy || !page.modelEnabled || running || !!page.result} onClick={generate}>{action.busy ? "正在提交…" : page.state === "failed" ? "重试选题生成" : "生成选题初版"}</button>
      <button disabled={action.busy} onClick={() => revalidator.revalidate()}>刷新选题进度</button></div>
    {!page.modelEnabled && <p className="studio-caption">模型调用尚未启用，请先配置服务端模型；这里仍可查看已保存结果。</p>}
    {page.error && <p className="studio-notice" role="alert">{page.error}</p>}<p className="studio-caption" role="status">{message}</p>
    {page.result && <TopicDirectionList batch={batch} result={page.result} references={page.referenceMaterials} />}
  </section>;
}
