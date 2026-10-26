import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { loadOr404 } from "../../../apps/web/app/lib/api.server";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { PhoneBar } from "../../../apps/web/app/components/shell/PhoneBar";
import type { Screen } from "../../../apps/web/app/components/shell/screens";
import type { FilmBoardsPage } from "../film-boards-contracts";

export const handle: Screen = { tab: "me", name: "影视榜" };
export function headers() { return { "Cache-Control": "no-store" }; }
export async function loader({ request, params }: LoaderFunctionArgs) {
  const region = params.region;
  if (region !== "domestic" && region !== "overseas") throw new Response("未找到影视榜", { status: 404 });
  const page = await loadOr404<FilmBoardsPage>(`/api/site/film-boards?region=${region}`, { signal: request.signal });
  page.boards = page.boards.filter(board => board.id !== "lvpaopao");
  const search = new URL(request.url).searchParams, requested = search.get("board");
  let genre = search.get("genre"), platform = search.get("platform");
  const selected = page.boards.find(board => board.id === (requested === "hongguo-app" ? "hongguo-web" : requested)) ?? page.boards.find(board => board.items.length > 0) ?? page.boards[0]!;
  if (genre && !selected.categories?.some(item => item.key === genre)) genre = null;
  if (platform && !selected.platforms?.some(item => item.key === platform)) platform = null;
  const allItems = selected.items;
  const items = allItems.filter(item => (!genre || item.genreKeys?.includes(genre)) && (!platform || item.sourcePlatform === platform));
  return { ...page, region, genre, platform, selected: { ...selected, items }, allItems };
}
export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const title = data?.region === "overseas" ? "国外AI影视榜" : "国内AI影视榜";
  return pageMeta({ title, description: "官方作品榜与短剧市场参考，各平台保留原始顺序和指标。", path: `/film/${data?.region ?? "domestic"}` });
}

export default function FilmBoards() {
  const { boards, selected: board, region, allItems, genre, platform } = useLoaderData<typeof loader>();
  const title = region === "overseas" ? "国外AI影视榜" : "国内AI影视榜";
  const genreCount = (key: string) => allItems.filter(item => item.genreKeys?.includes(key)).length;
  const filterHref = (next: { genre?: string | null; platform?: string | null }) => {
    const params = new URLSearchParams({ board: board.id });
    const g = next.genre === undefined ? genre : next.genre, p = next.platform === undefined ? platform : next.platform;
    if (g) params.set("genre", g); if (p) params.set("platform", p);
    return `?${params.toString()}`;
  };
  const groups = boards.filter((item, index) => boards.findIndex(first => (first.group?.id ?? first.id) === (item.group?.id ?? item.id)) === index);
  const groupId = board.group?.id ?? board.id;
  const categories = boards.filter(item => (item.group?.id ?? item.id) === groupId);
  const groupName = board.group?.name ?? board.name;
  return <div className="mx-auto w-full min-w-0 max-w-[1320px] pb-12">
    <PhoneBar back={{ to: "/more", label: "我的" }} title={title} />
    <header className="pb-5 pt-3 lg:pt-1">
      <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
    </header>
    <nav aria-label="选择影视榜单" className="mb-6 flex flex-wrap gap-2">
      {groups.map(item => <Link key={item.id} to={`?board=${item.id}`} aria-current={(item.group?.id ?? item.id) === groupId ? "page" : undefined}
        className={`rounded-control border px-3 py-2 text-[13px] transition-colors ${(item.group?.id ?? item.id) === groupId ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3 hover:text-ink"}`}>{item.group?.name ?? item.name}</Link>)}
    </nav>
    <section aria-label={groupName}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold text-ink [overflow-wrap:anywhere]">{groupName}</h2>
        </div>
        {board.sourceUrl && <a className="text-[13px] text-accent underline underline-offset-4" href={board.sourceUrl} target="_blank" rel="noreferrer">查看榜单来源</a>}
      </div>
      {categories.length > 1 && <nav aria-label={groupName + "分类"} className="mt-4 flex flex-wrap gap-2">{categories.map(item => <Link key={item.id} to={`?board=${item.id}`} aria-current={item.id === board.id ? "page" : undefined}
        className={`rounded-control border px-3 py-2 text-[13px] transition-colors ${item.id === board.id ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3 hover:text-ink"}`}>{item.group?.category ?? item.name}</Link>)}</nav>}
      {!!board.categories?.length && <nav aria-label="题材筛选" className="mt-4 flex flex-wrap gap-2">
        <Link to={filterHref({ genre: null })} aria-current={!genre ? "page" : undefined} className={`rounded-control border px-3 py-2 text-[13px] ${!genre ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3"}`}>全部题材</Link>
        {board.categories.filter(category => genreCount(category.key) > 0).map(category => <Link key={category.key} to={filterHref({ genre: category.key })}
          aria-current={genre === category.key ? "page" : undefined} className={`rounded-control border px-3 py-2 text-[13px] ${genre === category.key ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3"}`}>
          {category.labelZh ?? category.labelOriginal} <span className="num text-ink-4">{genreCount(category.key)}</span></Link>)}
      </nav>}
      {!!board.platforms?.length && <nav aria-label="平台筛选" className="mt-3 flex flex-wrap gap-2">
        <Link to={filterHref({ platform: null })} aria-current={!platform ? "page" : undefined} className={`rounded-control border px-3 py-2 text-[13px] ${!platform ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3"}`}>全部平台</Link>
        {board.platforms.filter(item => allItems.some(entry => entry.sourcePlatform === item.key)).map(item => <Link key={item.key} to={filterHref({ platform: item.key })}
          aria-current={platform === item.key ? "page" : undefined} className={`rounded-control border px-3 py-2 text-[13px] ${platform === item.key ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-3"}`}>{item.label}</Link>)}
      </nav>}
      <p className="mt-3 text-[13px] leading-[1.8] text-ink-3">仅供分享学习使用，{board.sourceUrl ? <a href={board.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-4">官方完整榜单请点击直达原站</a> : "官方完整榜单请点击直达原站"}。{board.id === "verticalcharts-52" ? "本页为第三方短剧榜，不是各平台官方榜的合并；VertiScore 不是播放量。" : ""}</p>
      {board.items.length > 0 && board.snapshotAt && <p className="mt-1 text-[12.5px] text-ink-3">{board.sourceUpdatedText ? `${board.sourceUpdatedText} · ` : ""}更新于 {fullDateTime(board.snapshotAt)}</p>}
      {!board.items.length ? <div className="py-14 text-center">
        <p className="text-[16px] text-ink">{allItems.length ? "该筛选在本站已取榜单中没有作品。" : "暂未接入榜单数据，请等待后续配置。"}</p>
      </div> : <>
        <div aria-hidden="true" className="mt-6 hidden grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_minmax(9rem,.65fr)] gap-8 rounded-control bg-bg-sunk px-6 py-4 text-[14px] font-semibold text-ink-2 xl:grid">
          <span>作品</span><span>简介</span><span className="text-right">来源热度</span>
        </div>
        <ol className="mt-2 divide-y divide-line-soft" aria-label="作品列表">
          {board.items.map(item => {
            const summary = region === "overseas" ? item.summaryZh ?? item.sourceSummary : item.sourceSummary;
            const country = item.productionCountries?.length ? item.productionCountries.join(" / ") : item.countryStatus === "conflict" ? "待核对" : "未注明";
            return <li key={item.id} className="grid min-w-0 gap-5 py-6 xl:min-h-40 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_minmax(9rem,.65fr)] xl:items-center xl:gap-8 xl:px-6">
              <div className="flex min-w-0 items-start gap-4">
                <span aria-label={`来源序号 ${item.position}`} className={`num flex h-12 w-11 shrink-0 items-center justify-center rounded-control text-[24px] font-bold ${item.position === 1 ? "bg-accent text-accent-contrast" : item.position <= 3 ? "border border-accent bg-accent-soft text-accent" : "text-ink-4"}`}>{item.position}</span>
                <div className="min-w-0">
                  <h3 className="text-[18px] font-semibold leading-relaxed text-ink [overflow-wrap:anywhere]">
                    <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-accent">{region === "overseas" ? item.titleZh ?? item.title : item.title}</a>
                  </h3>
                  {region === "overseas" && item.titleZh && <p className="mt-1 text-[13px] leading-relaxed text-ink-3 [overflow-wrap:anywhere]">{item.title}</p>}
                  {item.author && <p className="mt-2 text-[13px] text-ink-3 [overflow-wrap:anywhere]">{item.author}</p>}
                  {region === "overseas" && <p className="mt-2 text-[13px] text-ink-3">国别：{country}</p>}
                  <a href={item.url} target="_blank" rel="noreferrer" aria-label={`查看《${item.titleZh ?? item.title}》原站`} className="mt-2 inline-flex min-h-11 items-center text-[13px] text-accent underline underline-offset-4">直达原站</a>
                </div>
              </div>
              <div className="min-w-0 text-[15px] leading-[1.85] text-ink-2 [overflow-wrap:anywhere]">
                {item.summaryKind === "representative_episode" && <p className="mb-1 text-[12px] font-semibold text-ink-3">代表集简介 · 非整剧梗概</p>}
                {summary ? <>
                  <p>{summary.length > 500 ? `${summary.slice(0, 350)}…` : summary}</p>
                  {summary.length > 500 && <details className="mt-2"><summary className="cursor-pointer text-[13px] text-accent">展开完整简介</summary><p className="mt-2">{summary.slice(350, 4000)}</p></details>}
                </> : <p className="text-ink-3">{item.summaryStatus === "pending" ? "简介正在采集" : "来源未提供作品简介"}</p>}
              </div>
              <div className="min-w-0 text-right xl:self-center">
                {item.metrics.length ? item.metrics.map(metric => <div key={metric.name} className="py-1">
                  <p className="text-[12px] text-ink-3">{metric.name}</p>
                  <p title={metric.text} className="num mt-1 text-[24px] font-bold leading-tight text-accent [overflow-wrap:anywhere]">{metric.text}</p>
                </div>) : <p className="text-[13px] text-ink-3">来源未提供热度数字</p>}
              </div>
            </li>;
          })}
        </ol>
      </>}
    </section>
  </div>;
}
