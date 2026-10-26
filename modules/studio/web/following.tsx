import { useEffect, useRef, useState, type FormEvent } from "react";
import { SITE } from "@aihot/site";
import { Form, Link, useLoaderData, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { toast } from "../../../apps/web/app/features/admin/toast";
import { PanelDialog } from "./panel-dialog";
import { RemotePanel } from "./remote-panel";
import { NewsSourceEditor } from "./news-source-editor";
import { BridgeEditor } from "./news-bridge-editor";
import type { NewsSourceSettings, NewsBridgeSettings, NewsSourceCard, NewsSources } from "../contracts";
import { FollowingTabs } from "./following-tabs";
import { SourceAvatar } from "./source-avatar";

export async function loader({ request }: LoaderFunctionArgs) {
  const search = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ["q", "archived", "page"]) if (search.get(name)) query.set(name, search.get(name)!);
  const regionFilter = search.get("regionFilter");
  if (regionFilter === "missing") query.set("regionMissing", "true");
  else if (regionFilter?.startsWith("region:")) query.set("region", regionFilter.slice(7));
  if (search.get("archived") !== "true" && search.get("enabled")) query.set("enabled", search.get("enabled")!);
  query.set("limit", "24");
  if (search.get("archived") !== "true") query.set("excludeTrends", "true");
  return adminGet<NewsSources>(request, `/api/admin/studio/news-sources?${query}`);
}
export const meta = () => [{ title: `关注管理 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });
const date = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value)) : "尚无记录";
const kind: Record<string, string> = { rss: "RSS", external: "外部桥接", web_list: "网页", json_list: "JSON", x_search: "X", mp_account: "公众号" };
const health: Record<string, string> = { ok: "检查正常", degraded: "检查不稳定", failing: "检查失败" };
const tagLabels: Record<string, string> = { GLOBAL: "全球", CN: "中国", US: "美国", UK: "英国", media: "媒体", official: "官方", aggregator: "聚合", FILM: "影视", PHOTO: "摄影", security: "网络安全" };

function ProfileEditor({ source, close }: { source: NewsSourceCard; close: () => void }) {
  const action = useAdminAction("studio-layout");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const saved = await action.run("PUT", `/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/profile`, {
      version: source.profileVersion,
      ...Object.fromEntries(["description", "region", "language", "homepage"].map(key => [key, String(data.get(key) ?? "")])),
    }, { success: "资料已保存" });
    if (saved) close();
  }
  return <section className="studio-editor" aria-label={`编辑${source.name}资料`}>
    <h2>编辑资料 · {source.name}</h2>
    <p className="studio-caption">只填写可靠资料。自动补全不会覆盖手动修改的字段；主动清空后也会保留。</p>
    <form onSubmit={save}>
      <label className="studio-wide">简介<textarea ref={field} name="description" maxLength={1200} rows={3} defaultValue={source.description ?? ""} /></label>
      <label>主要服务地区<input name="region" maxLength={80} defaultValue={source.region ?? ""} /></label>
      <label>内容语言<input name="language" maxLength={80} defaultValue={source.language ?? ""} /></label>
      <label className="studio-wide">来源主页<input name="homepage" type="url" maxLength={2000} defaultValue={source.homepage ?? ""} aria-describedby="homepage-hint" />
        <span id="homepage-hint" className="studio-caption">填写公开的 HTTP(S) 主页，不含账号、查询参数或片段。</span></label>
      <div className="studio-wide studio-actions"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存资料"}</button>
        <button type="button" onClick={close} disabled={action.busy}>取消</button></div>
    </form>
  </section>;
}

function SourceCard({ source }: { source: NewsSourceCard }) {
  const action = useAdminAction("studio-layout"), [open, setOpen] = useState(false);
  const status = source.archived ? "已移除" : !source.enabled ? "已暂停" : health[source.health] ?? "尚未检查";
  async function refreshMetadata() {
    const result = await action.run<{ state: string; hasIcon: boolean; iconState: string }>("POST", `/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/refresh-profile`,
      { version: source.version, profileVersion: source.profileVersion });
    if (result) toast(result.state === "ok" ? (result.iconState === "failed" ? (result.hasIcon ? "资料已更新，头像读取失败，保留已有头像" : "资料已更新，头像读取失败，可稍后重试") : result.hasIcon ? "资料与头像已更新" : "资料已更新，暂未取得头像")
      : result.state === "needs_homepage" ? "请先在编辑资料中填写公开主页" : "暂时无法读取来源，保留已有资料，可稍后重试", result.state === "ok" ? "ok" : "error");
  }
  async function archive() {
    if (!source.archived && !window.confirm(`移除“${source.name}”？停止后续采集并保留历史材料，可在“已移除”列表恢复。`)) return;
    const saved = await action.run("PATCH", `/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/archive`,
      { version: source.version, archived: !source.archived },
      { success: source.archived ? "已恢复到关注列表，当前暂停；启用后继续采集" : "已移除来源，历史材料保留" });
    if (saved) setOpen(false);
  }
  const tags = source.tags.filter(tag => !/^(bridge|ingest):/i.test(tag)).map(tag => tagLabels[tag] ?? tag);
  const avatar = <SourceAvatar name={source.name} src={source.avatarUrl} />;
  return <article className={`studio-source${source.failureWarning ? " studio-source-warning" : ""}`} aria-label={source.name}>
    <header>{source.homepage ? <a href={source.homepage} target="_blank" rel="noopener noreferrer" aria-label={`打开${source.name}主页`}>{avatar}</a> : avatar}
      <div><h2>{source.name}</h2><p className="studio-caption">{kind[source.kind] ?? source.kind}</p></div>
    </header>
    {source.failureWarning && <p className="studio-source-failure" role="status">最近连续 {source.failureWarning.count} 次检查失败，已持续至少48小时。</p>}
    <p className={`studio-description ${source.description ? "" : "studio-caption"}`}>{source.description ?? "简介待补充"}</p>
    {tags.length > 0 && <p className="studio-tags">{tags.join(" · ")}</p>}
    <dl>
      <div><dt>服务地区</dt><dd>{source.region ?? "地区待补充"}</dd></div>
      <div><dt>内容语言</dt><dd>{source.language ?? "语言待补充"}</dd></div>
      <div><dt>最近发布</dt><dd>{date(source.latestPublishedAt)}</dd></div>
      <div><dt>成功检查</dt><dd>{date(source.lastCheckedAt)}</dd></div>
      <div><dt>已收录</dt><dd>{source.collectedCount.toLocaleString("zh-CN")} 条</dd></div>
      {source.validation && <div><dt>接入试读</dt><dd>{source.validation.state === "ok" ? `试读正常 · ${source.validation.itemCount} 条`
        : source.validation.state === "needs_config" ? "需配置提取规则" : "试读失败 · 待检查"}</dd></div>}
      {source.metadata && <div><dt>资料更新</dt><dd>{source.metadata.state === "ok" ? (source.metadata.iconState === "failed" ? "资料已更新 · 头像读取失败" : "已补全可取得资料") : source.metadata.state === "needs_homepage" ? "请补充公开主页" : "读取失败 · 可重试"}<br />{date(source.metadata.checkedAt)}</dd></div>}
    </dl>
    <footer><span className="studio-status" data-tone={!source.enabled ? "paused" : source.health}>{status}</span>
      <div className="studio-actions">{source.archived ? <button disabled={action.busy} onClick={archive}>{action.busy ? "处理中…" : "恢复到关注列表"}</button> : <>
        <button disabled={action.busy} onClick={() => setOpen(true)}>编辑资料</button>
        <button disabled={action.busy || !source.enabled && source.validation?.state === "needs_config"} onClick={() => action.run("PATCH", `/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/status`,
          { version: source.version, enabled: !source.enabled }, { success: source.enabled ? "已暂停后续采集，历史材料保留" : "已恢复关注，等待后续检查" })}>
          {action.busy ? "处理中…" : source.enabled ? "暂停关注" : "启用关注"}</button>
        </>}</div>
    </footer>
    {open && <PanelDialog title={`来源设置 · ${source.name}`} onClose={() => setOpen(false)} panels={[
      { id: "profile", label: "编辑资料", content: <ProfileEditor source={source} close={() => setOpen(false)} /> },
      { id: "metadata", label: "补全资料与头像", content: <section><h2>补全资料与头像</h2><p>从公开主页读取资料，保留你手动填写的字段。</p><button className="studio-primary" disabled={action.busy} onClick={refreshMetadata}>补全资料与头像</button></section> },
      { id: "collection", label: "采集设置", content: ["rss", "web_list"].includes(source.kind) ? <RemotePanel<NewsSourceSettings> url={`/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/configuration`}>{settings => <NewsSourceEditor settings={settings} onSaved={() => setOpen(false)} />}</RemotePanel> : source.kind === "external" ? <RemotePanel<NewsBridgeSettings> url={`/api/admin/studio/news-sources/${encodeURIComponent(source.id)}/bridge`}>{settings => <BridgeEditor settings={settings} onSaved={() => setOpen(false)} />}</RemotePanel> : <p>此来源沿用已有采集适配，暂无可编辑的提取设置。</p> },
      { id: "remove", label: "移除来源", content: <section><h2>移除来源</h2><p>停止后续采集，保留历史新闻、选题和稿件引用。</p><button disabled={action.busy} onClick={archive}>移除来源</button></section> },
    ]} />}
  </article>;
}

export default function Following() {
  const data = useLoaderData<typeof loader>();
  const [search] = useSearchParams();
  const archived = search.get("archived") === "true";
  const regionFilter = search.get("regionFilter") ?? "";
  const pageUrl = (page: number) => { const next = new URLSearchParams(search); next.set("page", String(page)); return `?${next}`; };
  return <div className="studio-screen-list">
    <header className="studio-page-header"><div><h1>关注管理</h1><p>管理你的信息入口，让每期选题有据可循。</p></div>
      <Link className="studio-button studio-primary" to="/admin/studio/news-sources/new">添加新闻源</Link></header>
    <FollowingTabs active="news" />
    <p className="studio-notice">{archived ? "已移除来源停止后续采集，历史材料保留。恢复后先保持暂停，可回到关注列表启用。" : "启用状态决定是否参与采集；实际结果以成功检查和收录记录为准。时间按香港时间显示。"}</p>
    <Form key={search.toString()} className="studio-filters" method="get">
      <input type="search" name="q" aria-label="搜索新闻源" placeholder="搜索名称或来源 ID" maxLength={200} defaultValue={search.get("q") ?? ""} />
      <select name="archived" aria-label="显示范围" defaultValue={archived ? "true" : "false"}><option value="false">当前关注</option><option value="true">已移除</option></select>
      <select name="enabled" aria-label="关注状态" disabled={archived} defaultValue={archived ? "" : search.get("enabled") ?? ""}><option value="">全部状态</option><option value="true">已启用</option><option value="false">已暂停</option></select>
      <select className="studio-region-filter" name="regionFilter" aria-label="服务地区" defaultValue={regionFilter}>
        <option value="">全部地区</option>
        {data.regionOptions.filter(option => option.region !== null).map(option => <option key={option.region} value={`region:${option.region}`}>{option.region}（{option.count}）</option>)}
        {regionFilter.startsWith("region:") && !data.regionOptions.some(option => option.region !== null && `region:${option.region}` === regionFilter)
          && <option value={regionFilter}>{regionFilter.slice(7)}（0）</option>}
        <option value="missing">地区待补充（{data.regionOptions.find(option => option.region === null)?.count ?? 0}）</option>
      </select>
      <button type="submit">搜索</button><Link to="/admin/studio/following">重置</Link>
      <span className="studio-result-count">{data.total} 个来源</span>
    </Form>
    <div className="studio-page-content">

    {data.rows.length ? <div className="studio-source-grid">{data.rows.map(source => <SourceCard key={source.id} source={source} />)}</div>
      : <section className="studio-empty"><h2>{archived ? "没有已移除的新闻源" : "没有匹配的新闻源"}</h2><p>{archived ? "移除的来源会保留在这里，可随时恢复到关注列表。" : "试试缩短关键词或重置筛选，也可以添加新的新闻源。"}</p></section>}
    </div><nav className="studio-pagination" aria-label="新闻源分页">
      {data.page > 1 && <Link className="studio-button" to={pageUrl(data.page - 1)}>上一页</Link>}
      <span>第 {data.page} 页</span>
      {data.hasMore && <Link className="studio-button" to={pageUrl(data.page + 1)}>下一页</Link>}
    </nav>
  </div>;
}
