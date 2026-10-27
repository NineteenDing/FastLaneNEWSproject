import { useEffect, useState } from "react";
import { Form, Link, isRouteErrorResponse, useLoaderData, useRouteError, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { num } from "../../../apps/web/app/features/admin/format";
import type { CreatorWork, IntelligenceDates, IntelligenceDetail, IntelligenceList, IntelligenceRow, MediaProcessingStatus, TopicColumns } from "../contracts";
import { creatorMetrics } from "./creator-metrics";
import { initialAnalysisLabel } from "./material-analysis-reading";
import { MaterialDetail, SourceAvatar } from "./material-reading";
import { MaterialDialog } from "./material-dialog";
import { SupplementMaterials } from "./supplement-materials";
import { SearchText, matchLabels } from "./intelligence-search";
export { externalUrl } from "./external-url";
export { MaterialEvidence, SourceAvatar } from "./material-reading";

const platforms = { news: "新闻源", bilibili: "B站", weibo: "微博", xhs: "小红书", zhihu: "知乎", tieba: "百度贴吧", douyin: "抖音", kuaishou: "快手" };
const kinds = { news: "新闻", video: "视频简介", post: "帖子", image_text: "图文笔记", answer: "回答", article: "文章" };
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const date = (value: string | null) => value ? clock.format(new Date(value)) : "发布时间未提供";
const collectionClock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false });
function metrics(row: Pick<IntelligenceRow, "metrics" | "kind">) { return row.metrics ? creatorMetrics(row.metrics, row.kind === "news" ? undefined : row.kind) : "新闻未提供互动指标"; }
const processingLabels: Record<string, string> = { new: "新闻待处理", analyzed: "原新闻分析完成", skipped: "原新闻处理已跳过", blocked: "原新闻处理已拦截", failed: "新闻处理失败", collected: "作品已收录", transcribed: "视频正文已保存" };
const fields = ["q", "kind", "platform", "origin", "column", "analysisState", "page", "view", "basis", "day", "month"];
const analysisFilters = { pending: "待安排", not_analyzed: "尚未登记", waiting_body: "等待完整正文", queued: "已排队", running: "处理中", completed: "已完成", failed: "需重试", superseded: "已交由批次处理" };
function queryOf(search: URLSearchParams) {
  const result = new URLSearchParams();
  for (const field of fields) if (search.get(field)) result.set(field, search.get(field)!);
  return result;
}
function NewArrivals({ query, total }: { query: string; total: number }) {
  const [count, setCount] = useState(0), [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>, pending: AbortController | undefined;
    const filters = new URLSearchParams(query), target = new URLSearchParams();
    for (const field of ["q", "kind", "platform", "origin", "column", "analysisState"]) if (filters.get(field)) target.set(field, filters.get(field)!);
    if (filters.get("view") === "archive") for (const field of ["basis", "day"]) if (filters.get(field)) target.set(field, filters.get(field)!);
    target.set("limit", "1"); if (filters.get("view") !== "archive") target.set("recent", "today");
    async function check() {
      if (!document.hidden) {
        const controller = new AbortController(); pending = controller;
        const deadline = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`/api/admin/studio/intelligence?${target}`, { signal: controller.signal, cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error("unavailable");
          const result: IntelligenceList = await response.json();
          if (!Number.isSafeInteger(result.total) || result.total < 0) throw new Error("invalid count");
          if (active) { setCount(Math.max(0, result.total - total)); setFailed(false); }
        } catch { if (active) setFailed(true); }
        finally { clearTimeout(deadline); pending = undefined; }
      }
      if (active) timer = setTimeout(check, 30_000);
    }
    timer = setTimeout(check, 30_000);
    return () => { active = false; clearTimeout(timer); pending?.abort(); };
  }, [query, total]);
  const latest = new URLSearchParams(query); latest.delete("page");
  const analysisFiltered = latest.has("column") || latest.has("analysisState");
  return <div aria-live="polite">{count > 0 && <p className="studio-notice"><Link to={`?${latest}`} reloadDocument>{analysisFiltered ? "筛选结果有更新，点击加载" : `有 ${num(count)} 条新内容，点击加载`}</Link></p>}
    {failed && <p className="studio-caption">新内容检查暂时失败，将自动重试。</p>}</div>;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (params.id) {
    const detail = await adminGet<IntelligenceDetail>(request, `/api/admin/studio/intelligence/${encodeURIComponent(params.id)}`);
    const media = detail.kind === "video" && detail.id.startsWith("creator:")
      ? await adminGet<MediaProcessingStatus>(request, `/api/admin/studio/media-processing/${detail.id.slice(8)}`) : null;
    const work = detail.kind === "news" ? null : (await adminGet<{ work: CreatorWork | null }>(request, `/api/admin/studio/intelligence/${encodeURIComponent(detail.id)}/work`)).work;
    return { view: "detail" as const, detail, media, work };
  }
  const search = queryOf(new URL(request.url).searchParams), query = new URLSearchParams();
  // Existing filtered bookmarks open the searchable archive; the default live view stays clean.
  if (["q", "kind", "platform", "origin", "column", "analysisState"].some(field => search.has(field))) search.set("view", "archive");
  for (const field of search.get("view") === "archive" ? ["q", "kind", "platform", "origin", "column", "analysisState", "page"] : ["page"]) if (search.get(field)) query.set(field, search.get(field)!);
  let dates: IntelligenceDates | null = null, selectedDay: string | null = null;
  if (search.get("view") === "archive") {
    const calendar = new URLSearchParams(query); calendar.delete("page");
    if (search.get("basis")) calendar.set("basis", search.get("basis")!);
    const month = search.get("day") && search.get("day") !== "undated" ? search.get("day")!.slice(0, 7) : search.get("month");
    if (month) calendar.set("month", month);
    dates = await adminGet<IntelligenceDates>(request, `/api/admin/studio/intelligence/dates?${calendar}`);
    selectedDay = search.get("day") ?? dates.days[0]?.day ?? (dates.months.length ? `${dates.month}-01` : null);
    query.set("basis", dates.basis); if (selectedDay) query.set("day", selectedDay);
  }
  query.set("limit", "30"); if (!dates) query.set("recent", "today");
  const [list, columns] = await Promise.all([adminGet<IntelligenceList>(request, `/api/admin/studio/intelligence?${query}`), adminGet<TopicColumns>(request, "/api/admin/studio/columns")]);
  return { view: "list" as const, dates, selectedDay, list, columns: columns.rows };
}
export const meta = () => [{ title: `情报库 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

export default function Intelligence() {
  const data = useLoaderData<typeof loader>(), [search] = useSearchParams();
  const [reading, setReading] = useState<string | null>(null);
  if (data.view === "detail") return <MaterialDetail item={data.detail} media={data.media} work={data.work} />;
  const { list, dates, selectedDay } = data, query = data.dates ? queryOf(search) : new URLSearchParams(search.has("page") ? { page: search.get("page")! } : {});
  if (dates) { query.set("view", "archive"); query.set("basis", dates.basis); query.set("month", dates.month); if (selectedDay) query.set("day", selectedDay); else query.delete("day"); }
  const pageUrl = (page: number) => { const target = new URLSearchParams(query); target.set("page", String(page)); return `?${target}`; };
  const viewUrl = (archive: boolean) => { if (!archive) return "/admin/studio/intelligence"; const target = new URLSearchParams(query); for (const field of ["view", "basis", "day", "month", "page"]) target.delete(field); target.set("view", "archive"); return `?${target}`; };
  const archiveUrl = (month: string, day?: string) => { const target = new URLSearchParams(query); target.delete("page"); target.delete("day"); target.set("month", month); if (day) target.set("day", day); return `?${target}`; };
  const years = [...new Set(dates?.months.map(row => row.month.slice(0, 4)))];
  return <div className="studio-screen-list studio-intelligence-screen">
    <div className="studio-page-header"><div><h1>情报库</h1><p>{dates ? "按日期回看新闻与关注博主的发布。" : "今天收录的全部新闻、博主内容和热榜材料，按香港时间排列。"}</p></div>
      <div className="studio-actions"><SupplementMaterials /><Link className="studio-button" to={`/admin/studio/intelligence?${query}`} reloadDocument>刷新动态</Link></div></div>
    <nav className="studio-tabs" aria-label="情报视图"><Link to={viewUrl(false)} aria-current={!dates ? "page" : undefined}>实时动态</Link><Link to={viewUrl(true)} aria-current={dates ? "page" : undefined}>日期归档</Link></nav>
    {dates && <Form method="get" className="studio-filters" key={query.toString()}>
      {dates && <input type="hidden" name="view" value="archive" />}
      <input name="q" aria-label="搜索情报" defaultValue={search.get("q") ?? ""} placeholder="标题、来源或正文关键词" maxLength={200} />
      <select name="kind" aria-label="内容类型" defaultValue={search.get("kind") ?? ""}><option value="">全部内容</option>{Object.entries(kinds).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
      <select name="platform" aria-label="来源平台" defaultValue={search.get("platform") ?? ""}><option value="">全部平台</option>{Object.entries(platforms).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
      <select name="origin" aria-label="发现方式" defaultValue={search.get("origin") ?? ""}><option value="">全部发现方式</option><option value="trends">热榜发现</option><option value="creators">博主发布</option></select>
      <select name="column" aria-label="初筛栏目" defaultValue={search.get("column") ?? ""}><option value="">全部栏目</option><option value="unclassified">尚未归类</option>{data.columns.map(column => <option key={column.id} value={column.id}>{column.name}{column.enabled ? "" : "（已停用）"}</option>)}</select>
      <select name="analysisState" aria-label="初筛状态" defaultValue={search.get("analysisState") ?? ""}><option value="">全部初筛状态</option>{Object.entries(analysisFilters).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {dates && <select name="basis" aria-label="归档日期口径" defaultValue={dates.basis}><option value="collected">按收录日期</option><option value="published">按发布日期</option></select>}
      <button>搜索</button><Link to={dates ? "/admin/studio/intelligence?view=archive" : "/admin/studio/intelligence"}>重置</Link><span className="studio-result-count">{num(list.total)} 条情报</span>
    </Form>}
    <p className="studio-notice">{dates ? `按${dates.basis === "published" ? "发布" : "收录"}日期归档 · 香港时间 · ${selectedDay === "undated" ? "未提供发布日期" : selectedDay ?? "暂无匹配日期"}` : `今天 · 香港时间 · ${num(list.total)} 条情报 · 每页30条，最新收录在上`}</p>
    {(!dates || ["q", "column", "analysisState"].some(field => query.has(field))) && <NewArrivals key={`${query}:${list.total}`} query={query.toString()} total={list.total} />}
    <div className={dates ? "studio-archive-layout studio-page-content" : "studio-page-content"}>
    {dates && <aside className="studio-date-tree" aria-label="情报日期导航">
      {years.map(year => <details key={year} open={year === dates.month.slice(0, 4)}><summary>{year} 年</summary>
        {dates.months.filter(row => row.month.startsWith(year + "-")).map(row => <div key={row.month}>
          <Link to={archiveUrl(row.month)} aria-current={row.month === dates.month ? "true" : undefined}>{Number(row.month.slice(5))} 月 <span>（{num(row.total)}）</span></Link>
          {row.month === dates.month && <ul>{dates.days.map(day => <li key={day.day}><Link to={archiveUrl(dates.month, day.day)} aria-current={selectedDay === day.day ? "date" : undefined}>{day.day.slice(5)} <span>（{num(day.total)}）</span></Link></li>)}</ul>}
        </div>)}
      </details>)}
      {!years.length && <p className="studio-caption">当前筛选没有可归档日期。</p>}
      {dates.basis === "published" && dates.undatedTotal > 0 && <Link to={archiveUrl(dates.month, "undated")} aria-current={selectedDay === "undated" ? "page" : undefined}>未提供发布日期（{num(dates.undatedTotal)}）</Link>}
    </aside>}
    <div>
    {list.rows.length ? <ul className="studio-material-list" aria-label="情报动态">{list.rows.map(row => <li key={row.id} className="studio-material-row">
      <time className="studio-intelligence-time" dateTime={dates?.basis === "published" ? row.publishedAt ?? undefined : row.collectedAt}
        title={date(dates?.basis === "published" ? row.publishedAt : row.collectedAt)}>{dates?.basis === "published" && !row.publishedAt ? "未提供" : collectionClock.format(new Date(dates?.basis === "published" ? row.publishedAt! : row.collectedAt))}</time>
      <SourceAvatar key={row.source.avatarUrl} source={row.source} />
      <Link className="studio-material-link" to={`/admin/studio/intelligence/${encodeURIComponent(row.id)}?${query}${row.match ? "#intelligence-search-match" : ""}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); setReading(row.id); } }}>
        <span className="studio-caption"><SearchText text={row.source.name} query={search.get("q") ?? ""} /> · {platforms[row.source.platform]} · {kinds[row.kind]}</span>
        <h2><SearchText text={row.title} query={search.get("q") ?? ""} /></h2>{row.originalTitle && <p className="studio-caption" lang="en">{row.originalTitle}</p>}<p className="studio-material-excerpt">{row.match && !["title", "source"].includes(row.match.field) ? <>{matchLabels[row.match.field]}：<SearchText text={row.match.text} query={search.get("q") ?? ""} /></> : row.excerpt || "来源暂无简介，可进入详情查看原文。"}</p>
        {row.source.work && <span className="studio-caption">同作品 {row.source.work.publicationCount} 条发布 · 进入查看各平台表现</span>}
        <span className="studio-material-meta"><span>发布：{date(row.publishedAt)}</span><span>{metrics(row)}</span></span>
        <span className="studio-caption">{processingLabels[row.processingState] ?? "处理状态待确认"} · {initialAnalysisLabel(row.analysisState)}</span>
      </Link>
    </li>)}</ul> : <div className="studio-empty"><h2>{list.total ? "这一页暂无内容" : ["q", "kind", "platform", "origin", "column", "analysisState"].some(field => query.has(field)) ? "没有匹配的情报" : dates ? "当天没有收录情报" : "还没有收录情报"}</h2>
      <p className="studio-caption">可以调整筛选条件，或在关注管理中配置来源并采集内容。</p><Link to="/admin/studio/following">前往关注管理</Link></div>}
    </div></div><nav className="studio-pagination" aria-label="情报分页">{list.page > 1 && <Link to={pageUrl(list.page - 1)}>上一页</Link>}<span>第 {list.page} 页</span>{list.hasMore && <Link to={pageUrl(list.page + 1)}>下一页</Link>}</nav>
    {reading && <MaterialDialog key={reading} id={reading} onClose={() => setReading(null)} />}
  </div>;
}

export function ErrorBoundary() {
  const error = useRouteError(), missing = isRouteErrorResponse(error) && error.status === 404;
  return <section className="studio-empty" role="alert"><h1>{missing ? "情报暂不可用" : "情报未能加载"}</h1>
    <p>{missing ? "这条内容尚未收录或已不存在。" : "请检查登录或网络后重试，已保存的内容不会因此删除。"}</p>
    <div className="studio-actions"><button onClick={() => window.location.reload()}>重新加载</button><Link to="/admin/studio/intelligence">返回情报库</Link></div></section>;
}
