import { PanelDialog } from "./panel-dialog";
import { RemotePanel } from "./remote-panel";
import { CreatorProfileView } from "./creator-profile";
import { CollectedContents } from "./collected-contents";
import type { CreatorExpressions } from "../contracts";
import { FollowingTabs } from "./following-tabs";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, Link, useLoaderData, useNavigate, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { toast } from "../../../apps/web/app/features/admin/toast";
import type { CreatorAccount, CreatorAccounts, CreatorContent, CreatorContents, CreatorPlatform } from "../contracts";
import { creatorMetrics as metrics } from "./creator-metrics";
import { MetricHistory } from "./metric-history";
import { SourceAvatar } from "./source-avatar";
import { CommentSamples } from "./comment-samples";

const platforms: Record<CreatorPlatform, string> = { xhs: "小红书", douyin: "抖音", kuaishou: "快手", bilibili: "B站", weibo: "微博", tieba: "百度贴吧", zhihu: "知乎" };
const date = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "尚无记录";
const amount = (value: number | null) => value === null ? "未提供" : new Intl.NumberFormat("zh-CN").format(value);
const title = (account: CreatorAccount) => account.name ?? `${platforms[account.platform]}博主 · ${account.locator}`;

export async function loader({ request }: LoaderFunctionArgs) {
  const search = new URL(request.url).searchParams, query = new URLSearchParams();
  for (const name of ["q", "platform", "archived", "enabled", "page"]) if (search.get(name)) query.set(name, search.get(name)!);
  query.set("limit", "24");
  return adminGet<CreatorAccounts>(request, `/api/admin/studio/creators?${query}`);
}
export const meta = () => [{ title: `博主关注 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

function AddCreator({ close }: { close: () => void }) {
  const action = useAdminAction("studio-layout"), navigate = useNavigate();
  const field = useRef<HTMLTextAreaElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; field.current?.focus(); return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await action.run<{ created: boolean; creator: CreatorAccount }>("POST", "/api/admin/studio/creators",
      { url: String(new FormData(event.currentTarget).get("url") ?? "") });
    if (!result || !mounted.current) return;
    toast(result.created ? "已加入关注库，资料待补齐" : result.creator.archived ? "该博主已在已移除列表，可恢复关注" : "该博主已在关注库，无需重复添加", "ok");
    close();
    navigate(result.creator.archived ? `?archived=true&q=${encodeURIComponent(result.creator.locator)}` : "/admin/studio/creators");
  }
  return <section className="studio-editor" aria-label="添加博主">
    <h2>添加博主</h2><p className="studio-caption" id="creator-url-hint">支持七平台完整个人主页，也可粘贴含一个链接的分享文案。B站、抖音、快手、小红书及微博短链会尝试解析；失效时请改用完整主页。</p>
    <form onSubmit={submit}>
      <label className="studio-wide">博主主页链接<textarea ref={field} name="url" required maxLength={8000} rows={3} aria-describedby="creator-url-hint" placeholder="粘贴个人主页链接或平台分享文案" /></label>
      <div className="studio-wide studio-actions"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在添加…" : "确认添加"}</button>
        <button type="button" onClick={close}>取消</button></div>
    </form>
  </section>;
}

function LinkSubjects({ accounts, close, saved }: { accounts: CreatorAccount[]; close: () => void; saved: () => void }) {
  const action = useAdminAction("studio-layout"), field = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const [mode, setMode] = useState("new"), [query, setQuery] = useState(""), [attempt, retry] = useState(0);
  const [subjects, setSubjects] = useState<Array<{ id: string; name: string; accountCount: number }> | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { mounted.current = true; field.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setSubjects(null); setFailed(false);
    void fetch(`/api/admin/studio/creator-subjects?q=${encodeURIComponent(query)}`, { credentials: "same-origin", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Read failed"); return await response.json(); })
      .then(result => { if (!controller.signal.aborted) setSubjects(result.rows); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [query, attempt]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const target = mode === "new" ? { name: String(values.get("name") ?? "") } : { subjectId: String(values.get("subjectId") ?? "") };
    const result = await action.run("POST", "/api/admin/studio/creator-subjects", { accounts: accounts.map(({ id, version }) => ({ id, version })), ...target },
      { success: "已关联同一博主，后续选题按同一人识别" });
    if (result && mounted.current) saved();
  }
  return <section className="studio-editor" aria-label="关联同一博主">
    <h2>关联同一博主</h2><p className="studio-caption">已选择：{accounts.map(account => `${title(account)}（${platforms[account.platform]}）`).join("、")}。仅移动所选账号，其他账号保持原关联；历史选题和稿件保留当时身份。</p>
    <form onSubmit={submit}>
      <label className="studio-wide">关联方式<select aria-label="关联方式" value={mode} onChange={event => setMode(event.target.value)}><option value="new">建立新的博主主体</option><option value="existing">加入已有博主主体</option></select></label>
      {mode === "new" ? <label className="studio-wide">博主主体名称<input ref={field} name="name" required maxLength={100} placeholder="填写你能辨认的博主名称" /></label> : <>
        <label>查找已有主体<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="按主体名称查找" /></label>
        {failed ? <div role="status"><p>主体列表读取失败，请重试。</p><button type="button" onClick={() => retry(n => n + 1)}>重新读取主体</button></div>
          : subjects === null ? <p role="status">正在读取主体…</p>
          : <label>已有博主主体<select aria-label="已有博主主体" name="subjectId" required defaultValue=""><option value="">请选择（最多显示50项，可搜索）</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name} · {subject.accountCount} 个账号</option>)}</select></label>}
      </>}
      <div className="studio-wide studio-actions"><button className="studio-primary" disabled={action.busy || (mode === "existing" && !subjects?.length)}>{action.busy ? "正在关联…" : "确认关联"}</button>
        <button type="button" onClick={close}>取消</button></div>
    </form>
  </section>;
}


function CreatorCard({ account, selected, selectionDisabled, onSelect }: { account: CreatorAccount; selected: boolean; selectionDisabled: boolean; onSelect: () => void }) {
  const action = useAdminAction("studio-layout"), label = title(account);
  const [expanded, setExpanded] = useState(false);
  const collectionLabel = { not_connected: account.collectionSupported ? "尚未采集" : "采集接入中", running: "正在采集", ready: "最近采集成功", failed: "采集失败，可重试",
    interrupted: "本次采集中断", login_required: "需要平台登录", rate_limited: "平台限流，稍后重试" }[account.collectionState];
  async function archive() {
    if (!account.archived && !window.confirm(`移除“${label}”？后续停止采集，历史材料仍保留。`)) return;
    await action.run("PATCH", `/api/admin/studio/creators/${account.id}/archive`, { version: account.version, archived: !account.archived },
      { success: account.archived ? "已恢复到关注库，当前暂停" : "已移除关注，历史记录保留" });
  }
  return <article className="studio-source" aria-label={label}>
    <header><input type="checkbox" checked={selected} disabled={selectionDisabled} onChange={onSelect} aria-label={`选择${label}`} />
      <a href={account.homepage} target="_blank" rel="noopener noreferrer" aria-label={`打开${label}主页`}>
      <SourceAvatar name={label} src={account.avatarUrl} /></a>
      <div><h2>{label}</h2><p className="studio-caption">{platforms[account.platform]}</p></div></header>
    <p className="studio-description studio-caption">{account.description ?? "简介待补齐"}</p>
    {account.subject && <p className="studio-caption">同一博主：{account.subject.name}</p>}
    <dl>
      <div><dt>粉丝数</dt><dd>{amount(account.followerCount)}</dd></div>
      <div><dt>平台作品</dt><dd>{amount(account.workCount)}</dd></div>
      <div><dt>最近发布</dt><dd>{date(account.latestPublishedAt)}</dd></div>
      <div><dt>成功检查</dt><dd>{date(account.lastCheckedAt)}</dd></div>
      <div><dt>添加时间</dt><dd>{date(account.addedAt)}</dd></div>
      <div><dt>本库收录</dt><dd>{account.collectedCount} 条</dd></div>
    </dl>
    {account.collectionCoverage && !account.collectionCoverage.complete && <p className="studio-caption">已检查第 {account.collectionCoverage.page} 页，后续页面等待继续采集。</p>}
    <footer><span className="studio-status">{account.archived ? "已移除" : !account.enabled ? "已暂停" : collectionLabel}</span>
      <div className="studio-actions"><button onClick={() => setExpanded(true)}>博主档案</button>
        {!account.archived && <button disabled={action.busy} onClick={() => action.run("PATCH", `/api/admin/studio/creators/${account.id}/status`,
        { version: account.version, enabled: !account.enabled }, { success: account.enabled ? "已暂停关注" : "已启用关注，等待后台检查" })}>{action.busy ? "处理中…" : account.enabled ? "暂停关注" : "启用关注"}</button>}
        <a className="studio-button" href={account.homepage} target="_blank" rel="noopener noreferrer">查看主页</a></div></footer>
    {expanded && <PanelDialog title={label} onClose={() => setExpanded(false)} panels={[
      { id: "contents", label: "查看收录", content: <CollectedContents id={account.id} /> },
      { id: "profile", label: "档案与表达模式", content: <RemotePanel<CreatorExpressions> url={`/api/admin/studio/creators/${account.id}/expressions`}>{(expressions, refresh) => <CreatorProfileView creator={account} expressions={expressions} embedded refreshExpressions={refresh} />}</RemotePanel> },
      { id: "operations", label: "关注与采集", content: <section><h2>关注与采集</h2><button disabled={action.busy || !account.enabled || !account.collectionSupported} onClick={() => action.run("POST", `/api/admin/studio/creators/${account.id}/collect`, {})}>采集更新</button><button disabled={action.busy} onClick={archive}>{account.archived ? "恢复到关注库" : "移除关注"}</button></section> },
    ]} />}
  </article>;
}

export default function Creators() {
  const data = useLoaderData<typeof loader>(), [search] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), batch = useAdminAction("studio-layout");
  const [linking, setLinking] = useState<CreatorAccount[] | null>(null);
  const selection = data.rows.filter(account => selected.includes(account.id));
  useEffect(() => { setSelected([]); setLinking(null); }, [search.toString()]);
  const addButton = useRef<HTMLButtonElement>(null);
  const archived = search.get("archived") === "true";
  async function changeSelected(change: { enabled: boolean } | { archived: boolean }) {
    if ("archived" in change && change.archived && !window.confirm(`移除选中的 ${selection.length} 个博主？历史材料保留。`)) return;
    const result = await batch.run("POST", "/api/admin/studio/creators/batch", { accounts: selection.map(({ id, version }) => ({ id, version })), ...change },
      { success: `已更新 ${selection.length} 个博主` });
    if (result) setSelected([]);
  }
  async function unlinkSelected() {
    const result = await batch.run("POST", "/api/admin/studio/creator-subjects", { accounts: selection.map(({ id, version }) => ({ id, version })), subjectId: null },
      { success: "已解除所选账号关联，历史记录保留" });
    if (result) { setSelected([]); setLinking(null); }
  }
  function close() { setAdding(false); addButton.current?.focus(); }
  const pageUrl = (page: number) => { const next = new URLSearchParams(search); next.set("page", String(page)); return `?${next}`; };
  return <div className="studio-screen-list">
    <header className="studio-page-header"><div><h1>关注管理</h1><p>跟踪创作同行，为每期选题积累素材。</p></div>
      <button ref={addButton} className="studio-primary" onClick={() => setAdding(true)} aria-expanded={adding}>添加博主</button></header>
    <FollowingTabs active="creators" />
    <p className="studio-notice">{archived ? "移除后保留账号和历史记录，恢复后先暂停，启用后再参与后续采集。" : "七个平台已接入后台采集，实际可采范围取决于平台会话、验证要求及接口状态。未取得的指标显示“未提供”。"} <Link to="/admin/studio/settings/platforms">配置平台登录</Link></p>
    {adding && <AddCreator close={close} />}
    <Form key={search.toString()} className="studio-filters" method="get" onSubmit={() => setAdding(false)}>
      <input type="search" name="q" aria-label="搜索博主" placeholder="搜索名称或平台账号" maxLength={200} defaultValue={search.get("q") ?? ""} />
      <select name="platform" aria-label="博主平台" defaultValue={search.get("platform") ?? ""}><option value="">全部平台</option>{Object.entries(platforms).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select name="archived" aria-label="显示范围" defaultValue={archived ? "true" : "false"}><option value="false">当前关注</option><option value="true">已移除</option></select>
      <select name="enabled" aria-label="关注状态" defaultValue={search.get("enabled") ?? ""}><option value="">全部状态</option><option value="true">已启用</option><option value="false">已暂停</option></select>
      <button type="submit">搜索</button><Link to="/admin/studio/creators" onClick={() => setAdding(false)}>重置</Link><span className="studio-result-count">{data.total} 个博主</span>
    </Form>
    {!!data.rows.length && <div className="studio-actions studio-creator-batch" role="group" aria-label="批量管理博主">
      <label><input type="checkbox" disabled={batch.busy || !!linking} checked={selection.length === data.rows.length} onChange={event => setSelected(event.target.checked ? data.rows.map(account => account.id) : [])} /> 选择本页</label>
      <span className="studio-caption">已选 {selection.length} 个</span>
      {!archived && <><button disabled={batch.busy || !!linking || !selection.length} onClick={() => changeSelected({ enabled: false })}>批量暂停</button>
        <button disabled={batch.busy || !!linking || !selection.length} onClick={() => changeSelected({ enabled: true })}>批量启用</button></>}
      <button disabled={batch.busy || !!linking || !selection.length} onClick={() => changeSelected({ archived: !archived })}>{archived ? "批量恢复" : "批量移除"}</button>
      <button disabled={batch.busy || !selection.length || !!linking} onClick={() => setLinking(selection)}>关联为同一博主</button>
      <button disabled={batch.busy || !!linking || !selection.some(account => account.subject)} onClick={unlinkSelected}>解除关联</button>
    </div>}
    {linking && <LinkSubjects accounts={linking} close={() => setLinking(null)} saved={() => { setLinking(null); setSelected([]); }} />}
    <div className="studio-page-content">{data.rows.length ? <div className="studio-source-grid">{data.rows.map(account => <CreatorCard key={account.id} account={account} selected={selected.includes(account.id)} selectionDisabled={batch.busy || !!linking}
      onSelect={() => setSelected(current => current.includes(account.id) ? current.filter(id => id !== account.id) : [...current, account.id])} />)}</div>
      : <section className="studio-empty"><h2>{archived ? "没有已移除的博主" : "还没有匹配的博主"}</h2><p>可以粘贴主页加入关注，或调整上方筛选。</p></section>}
    </div><nav className="studio-pagination" aria-label="博主分页">{data.page > 1 && <Link className="studio-button" to={pageUrl(data.page - 1)}>上一页</Link>}
      <span>第 {data.page} 页</span>{data.hasMore && <Link className="studio-button" to={pageUrl(data.page + 1)}>下一页</Link>}</nav>
  </div>;
}
