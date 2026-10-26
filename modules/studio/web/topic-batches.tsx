import { BatchTimeline } from "./batch-timeline";
import { useEffect, useRef } from "react";
import { Form, Link, isRouteErrorResponse, useLoaderData, useRouteError, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { num } from "../../../apps/web/app/features/admin/format";
import type { CurrentTopicPreview, TopicBatch, TopicBatchPage, TopicColumns, TopicMaterialPage, TopicPresentation } from "../contracts";
import { TopicTabs } from "./topic-tabs";
import { loadFrozenProcessing } from "./topic-processing.server";
import { TopicCards } from "./topic-cards";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const date = (value: string) => clock.format(new Date(value));
const range = (batch: { startsAt: string; endsAt: string }) => `${date(batch.startsAt)} — ${date(batch.endsAt)}`;
function BatchRange({ batch }: { batch: { startsAt: string; endsAt: string } }) {
  return <span className="studio-batch-range"><time dateTime={batch.startsAt}>{date(batch.startsAt)}</time><span>—</span><time dateTime={batch.endsAt}>{date(batch.endsAt)}</time></span>;
}
function recommendationLabel(batch: TopicBatch) {
  return batch.recommendationState === "reviewed" ? batch.reviewVerdict === "passed" ? "选题审核通过" : batch.reviewVerdict === "no_materials" ? "无材料，无需审核" : "两轮审核并修订已完成"
    : batch.recommendationState === "draft" ? "选题初版已保存，待审核" : "选题尚未生成";
}
const adoptionLabel = (batch: TopicBatch) => batch.adoptionState === "adopted" ? `已采纳 ${batch.adoptedDirectionCount} 个方向 · ${batch.draftCount} 篇稿件` : batch.selectionState === "incomplete" ? "未完成" : "未采纳";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const search = new URL(request.url).searchParams, query = new URLSearchParams({ limit: "30" });
  if (search.get("page")) query.set("page", search.get("page")!);
  if (params.id) {
    return { view: "snapshot" as const, ...await loadFrozenProcessing(request, params.id, query) };
  }
  if (search.get("view") === "history") {
    for (const key of ["q", "from", "to"]) if (search.get(key)) query.set(key, search.get(key)!);
    const list = await adminGet<TopicBatchPage>(request, `/api/admin/studio/topic-batches?${query}`);
    const id = search.get("batch") ?? list.rows[0]?.id;
    return { view: "history" as const, list, filters: { q: search.get("q") ?? "", from: search.get("from") ?? "", to: search.get("to") ?? "" },
      selected: id ? await loadFrozenProcessing(request, id, new URLSearchParams({ limit: "30", page: search.get("materialPage") ?? "1" })) : null };
  }
  const presentation = await adminGet<TopicPresentation>(request, "/api/admin/studio/topic-batches/presentation");
  if (presentation.batch) return { view: "presented" as const, presentation, ...await loadFrozenProcessing(request, presentation.batch.id, query) };
  const [batch, materials, columns] = await Promise.all([
    adminGet<CurrentTopicPreview>(request, "/api/admin/studio/topic-batches/current/preview"),
    adminGet<TopicMaterialPage>(request, `/api/admin/studio/topic-batches/current/materials?${query}`),
    adminGet<TopicColumns>(request, "/api/admin/studio/columns"),
  ]);
  return { view: "current" as const, batch, materials, columns };
}
export const meta = () => [{ title: `选题台 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

export default function TopicBatches() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const refreshedDeadline = useRef<string | null>(null);
  const deadline = data.view === "presented" ? data.presentation.displayUntil : data.view === "current" ? data.batch.stage === "scheduled" ? data.batch.startsAt : data.batch.endsAt : null;
  useEffect(() => {
    if (!deadline) return;
    // Read-only updates wait while a user is reading a modal or entering adoption requirements.
    const refresh = () => { if (document.visibilityState === "visible" && !document.querySelector("dialog[open]") && revalidator.state === "idle") void revalidator.revalidate(); };
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { if (Date.now() >= Date.parse(deadline)) refreshedDeadline.current = deadline; refresh(); timer = setTimeout(tick, 30_000); };
    // A skewed browser clock or a delayed server must not re-arm the same expired
    // deadline after each loader response. Keep the normal 30-second polling interval.
    timer = setTimeout(tick, refreshedDeadline.current === deadline ? 30_000 : Math.min(30_000, Math.max(50, Date.parse(deadline) - Date.now() + 50)));
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [deadline, revalidator]);
  if (data.view === "history") return <div className="studio-screen-list studio-history-screen">
    <header className="studio-page-header"><div><h1>历史选题</h1><p>按期查看方向、采纳情况与已确认定稿数。</p></div></header><TopicTabs view="history" />
    <Form method="get" action="/admin/studio/topics" className="studio-topic-history-search" key={`${data.filters.q}:${data.filters.from}:${data.filters.to}`}>
      <input type="hidden" name="view" value="history" /><label>日期或标题<input name="q" defaultValue={data.filters.q} maxLength={200} placeholder="搜索方向或稿件标题" /></label>
      <label>开始日期<input name="from" type="date" defaultValue={data.filters.from} /></label><label>结束日期<input name="to" type="date" defaultValue={data.filters.to} /></label><button type="submit">查找</button><Link to="/admin/studio/topics?view=history">清除</Link>
    </Form>
    <div className="studio-topic-history-layout"><BatchTimeline initial={data.list} selected={data.selected?.batch.id} query={new URLSearchParams(data.filters).toString()} href={batch => `/admin/studio/topics?${new URLSearchParams({ view: "history", ...data.filters, batch })}`} />
      <div className="studio-history-content">{data.selected ? <FrozenTopics key={data.selected.batch.id} data={data.selected} /> : <div className="studio-empty"><h2>{data.filters.q || data.filters.from || data.filters.to ? "没有符合条件的批次" : data.list.total ? "这一页暂无批次" : "还没有历史批次"}</h2><p>调整筛选条件或等待两日批次保存。</p></div>}</div>
    </div>
  </div>;
  if (data.view === "snapshot" || data.view === "presented") return <>
    <header className="studio-page-header"><div><h1>{data.view === "presented" ? "当期选题" : "历史批次"}</h1><p>{range(data.batch)} · 香港时间</p></div><Link className="studio-button" to="/admin/studio/topics?view=history">查看历史</Link></header>
    <TopicTabs view={data.view === "presented" ? "current" : "history"} />
    {data.view === "presented" && <p className="studio-caption">本期显示至 {date(data.presentation.displayUntil!)}。下一期正在后台收集，已收录 {num(data.presentation.collection.materialCount)} 条。</p>}
    <FrozenTopics key={data.batch.id} data={data} />
  </>;
  return <>
    <header className="studio-page-header"><div><h1>当期选题</h1><p>汇集两日材料，围绕 AI 影视创作问题形成方向。</p></div><Link className="studio-button" to="/admin/studio/topics" reloadDocument>刷新当期</Link></header>
    <TopicTabs view="current" />
    <section className="studio-batch-overview" aria-label="当期概览"><h2><BatchRange batch={data.batch} /></h2><p className="studio-caption">香港时间 · 按收录时间归集 · 截止时刻的内容进入下一批</p>
      <p>{num(data.batch.materialCount)} 条材料 · {data.batch.stage === "scheduled" ? "待开始" : "收集中"} · {data.batch.result ? "持续更新中 · 截止后统一审核" : data.batch.state === "queued" || data.batch.state === "running" ? "选题处理中" : "选题尚未生成"}</p></section>
    {data.batch.stale && <p className="studio-notice">有新材料待处理，后台会继续更新；当前保留上次完成的选题与依据。</p>}
    {data.batch.error && <p className="studio-notice" role="alert">{data.batch.error}</p>}
    <TopicCards key={`${data.batch.id}:${data.batch.version}:${data.batch.startsAt}`} columns={data.batch.columns ?? data.columns.rows} result={data.batch.result} references={data.batch.referenceMaterials ?? []}
      supplementScope={data.batch.stage === "collecting" ? { startsAt: data.batch.startsAt } : undefined}
      pending={data.batch.state === "queued" || data.batch.state === "running"}
      materialPath={data.batch.id && data.batch.version ? id => `/api/admin/studio/topic-previews/${data.batch.id}/versions/${data.batch.version}/materials/${encodeURIComponent(id)}` : undefined} />
    
  </>;
}

type FrozenView = Awaited<ReturnType<typeof loadFrozenProcessing>>;
function FrozenTopics({ data }: { data: FrozenView }) {
  const result = data.review.result ?? data.recommendations.result;
  return <>
    <section className="studio-batch-overview" aria-label="批次概览"><h2><BatchRange batch={data.batch} /></h2>
      <p>{num(data.batch.materialCount)} 条材料 · {adoptionLabel(data.batch)} · 已确认定稿 {data.batch.finalizedDraftCount ?? 0} 篇</p><p className="studio-caption">{recommendationLabel(data.batch)} · 版本 {data.batch.revision ?? 1}</p></section>
    <TopicCards columns={data.batch.columns} result={result} references={data.review.result ? data.review.referenceMaterials : data.recommendations.referenceMaterials} batch={data.batch}
      reviewed={data.review.state === "completed" && !!data.review.result} pending={[data.recommendations.state, data.review.state].some(state => state === "queued" || state === "running")}
      materialPath={id => `/api/admin/studio/topic-batches/${data.batch.id}/materials/${encodeURIComponent(id)}`} />
    
  </>;
}

export function ErrorBoundary() {
  const error = useRouteError(), missing = isRouteErrorResponse(error) && error.status === 404;
  return <section className="studio-empty" role="alert"><h1>{missing ? "批次暂不可用" : "选题批次未能加载"}</h1>
    <p>{missing ? "这个批次尚未保存或不存在，可以返回历史列表。" : "请检查登录或网络后重试，已保存的批次不会因此删除。"}</p>
    <div className="studio-actions"><button onClick={() => window.location.reload()}>重新加载</button><Link to="/admin/studio/topics?view=history">返回历史</Link></div></section>;
}
