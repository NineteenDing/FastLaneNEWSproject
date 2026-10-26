import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminFeedback, AdminFeedbackRow } from "@aihot/contracts/admin";
import type { SiteManagement, StudioSiteRelease } from "../site-management-contracts";
import type { FilmBoard, FilmBoardsPage } from "../film-boards-contracts";
import type { DailyEditionPage } from "../contracts";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { ReleaseTimeline } from "./release-timeline";
import { FEEDBACK_STATUS } from "../../../apps/web/app/features/admin/labels";

export interface SiteManagementData { site: SiteManagement; films: FilmBoardsPage; daily: DailyEditionPage; feedback: AdminFeedback }
const boardStates: Record<FilmBoard["state"], string> = { pending: "待采集", queued: "等待处理", running: "采集中", ready: "已有数据", empty: "来源为空", failed: "采集失败", paused: "已暂停", not_connected: "暂未接入" };
const dailyStates = { pending: "待编排", queued: "编排中", fallback: "模板已出刊", completed: "已出刊", failed: "编排失败" };

function FilmRow({ board }: { board: FilmBoard }) {
  const action = useAdminAction("studio-layout");
  return <li className="studio-site-row">
    <div><h3>{board.name} <span className="studio-caption">{boardStates[board.state]}</span></h3>
      <p className="studio-caption">{board.scope === "ai" ? "AI作品" : "市场参考"} · 当前{board.items.length}项 · {board.snapshotAt ? `最近成功 ${new Date(board.snapshotAt).toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong", hour12: false })}` : "尚无成功结果"}</p>
      <p className="studio-caption">{board.note}</p>{board.error && <p className="studio-source-failure">{board.error}</p>}
    </div>
    <div className="studio-actions"><span className="studio-caption">仅前20名 · 不保存封面</span>
      <button type="button" className="studio-slide-switch" role="switch" aria-label={`${board.name}采集开关`} aria-checked={board.enabled} disabled={action.busy} onClick={() => void action.run("PUT", `/api/admin/studio/film-boards/${board.id}`, { version: board.version, enabled: !board.enabled, limit: 20 }, { success: "采集开关已保存" })}><span /></button>
      <button disabled={action.busy || !board.supported || !board.enabled || board.state === "queued" || board.state === "running"} onClick={() => void action.run("POST", `/api/admin/studio/film-boards/${board.id}/collect`, {}, { success: "已提交采集" })}>立即采集</button>
      {board.region === "overseas" && board.supported && <button disabled={action.busy || !board.enabled || !board.items.length} onClick={() => void action.run("POST", `/api/admin/studio/film-boards/${board.id}/translate`, {}, { success: "已检查待翻译内容；启用模型后自动处理" })}>检查中文翻译</button>}
      <Link className="studio-button" to={`/film/${board.region}?board=${board.id}`}>查看公开榜单</Link>
    </div>
  </li>;
}

function FeedbackRow({ row }: { row: AdminFeedbackRow }) {
  const action = useAdminAction("studio-layout"), [status, setStatus] = useState(row.status), [note, setNote] = useState(row.note ?? "");
  return <li className="studio-site-row">
    <p className="studio-caption">{new Date(row.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong", hour12: false })} · {FEEDBACK_STATUS[row.status] ?? row.status}{row.email ? ` · ${row.email}` : ""}</p>
    <p className="studio-site-text">{row.content}</p>
    {row.page_url && <p className="studio-caption">相关页面：{row.page_url}</p>}
    {row.screenshot === "local" && <a href={`/api/admin/feedback/${row.id}/screenshot`} target="_blank" rel="noreferrer">查看私有截图</a>}
    <div className="studio-actions"><label>处理状态<select aria-label={`反馈${row.id}处理状态`} value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(FEEDBACK_STATUS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="studio-site-note">内部备注<input aria-label={`反馈${row.id}内部备注`} value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      <button disabled={action.busy} onClick={() => void action.run("PATCH", `/api/admin/feedback/${row.id}`, { status, note, version: row.updated_at }, { success: "反馈处理已保存" })}>保存处理</button></div>
  </li>;
}

export function SiteManagementSettings({ data }: { data: SiteManagementData }) {
  const action = useAdminAction("studio-layout"), [value, setValue] = useState(data.site), [stored, setStored] = useState(data.site), [aboutText, setAboutText] = useState(data.site.about.paragraphs.join("\n\n")), [params] = useSearchParams();
  const panel = ["about", "changelog", "publication", "feedback"].includes(params.get("panel") ?? "") ? params.get("panel")! : "about";
  async function save(scope: "about" | "releases") {
    const next = scope === "about" ? { ...value.about, paragraphs: aboutText.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean) } : value.releases;
    const saved = await action.run<SiteManagement>("PUT", "/api/admin/studio/site-management", { ...stored, [scope]: next }, { success: scope === "about" ? "关于资料已保存" : "更新日志已保存" });
    if (saved) { setStored(saved); setValue(current => ({ ...current, version: saved.version, [scope]: saved[scope] })); if (scope === "about") setAboutText(saved.about.paragraphs.join("\n\n")); }
  }
  async function saveReleases(releases: StudioSiteRelease[]) {
    const saved = await action.run<SiteManagement>("PUT", "/api/admin/studio/site-management", { ...stored, releases }, { success: "更新日志已保存" });
    if (!saved) return false;
    setStored(saved); setValue(current => ({ ...current, version: saved.version, releases: saved.releases })); return true;
  }
  return <section className="studio-site-management">
    <nav className="studio-tabs" aria-label="站点管理分类">{[["about", "关于资料"], ["changelog", "更新日志"], ["publication", "公开内容与榜单"], ["feedback", "访客反馈"]].map(([key, label]) => <Link key={key} to={`?panel=${key}`} aria-current={panel === key ? "page" : undefined}>{label}</Link>)}</nav>
    {panel === "about" && <form className="studio-site-form" onSubmit={e => { e.preventDefault(); void save("about"); }}>
      <h2>关于资料</h2><p className="studio-caption">文字直接公开展示。四个二维码沿用原PDF，免责声明保留来源版权与本站反馈入口。</p>
      <label>页面标题<input value={value.about.title} maxLength={120} required onChange={e => setValue(current => ({ ...current, about: { ...current.about, title: e.target.value } }))} /></label>
      <label>一句话介绍<input value={value.about.subtitle} maxLength={500} onChange={e => setValue(current => ({ ...current, about: { ...current.about, subtitle: e.target.value } }))} /></label>
      <label>工作室介绍（空行分段）<textarea rows={7} value={aboutText} onChange={e => setAboutText(e.target.value)} /></label>
      <div className="studio-actions"><button className="studio-primary" disabled={action.busy}>保存关于资料</button><Link className="studio-button" to="/about" target="_blank">查看公开页面</Link></div>
    </form>}
    {panel === "changelog" && <section><header className="studio-actions"><h2>更新日志</h2><Link className="studio-button" to="/changelog" target="_blank">查看公开日志</Link></header>
      <p className="studio-caption">选中时间轴上的日志进行编辑。勾选“公开发布”并保存后才在公开站展示。</p>
      <ReleaseTimeline rows={stored.releases} busy={action.busy} save={saveReleases} />
    </section>}
    {panel === "publication" && <section><h2>公开内容与榜单</h2><p className="studio-caption">新闻的评分、依据和公开状态在情报详情查看。榜单和日报仅读已有结果；采集和重试需要相应后台许可。</p>
      <div className="studio-actions"><Link className="studio-button" to="/admin/studio/intelligence">查看新闻及公开状态</Link><Link className="studio-button" to="/admin/studio/settings/filters">调整内容筛选</Link><Link className="studio-button" to="/">查看公开站</Link></div>
      <h3>日报</h3><ul>{data.daily.rows.map(row => <li key={row.day} className="studio-site-row"><div className="studio-actions"><strong>{row.day}</strong><span>{dailyStates[row.state]}</span><span>{row.count}条材料</span>{row.revision !== null && <Link to={`/daily/${row.day}`} target="_blank">查看日报</Link>}{row.state !== "queued" && row.state !== "completed" && row.count > 0 && <button disabled={action.busy || !data.daily.modelEnabled} onClick={() => void action.run("POST", `/api/admin/studio/daily-editions/${row.day}/retry`, {}, { success: "已提交日报修订" })}>重试编排</button>}</div>{row.error && <p className="studio-source-failure">{row.error}</p>}</li>)}</ul>{!data.daily.rows.length && <p className="studio-caption">尚无日报任务，每天香港时间08:00按已有合格材料生成。</p>}
      <h3>影视榜单</h3><p className="studio-caption">每天香港时间07:00更新。固定前20项，失败保留最近成功结果；各平台顺序与指标分别展示。</p><ul>{data.films.boards.map(board => <FilmRow key={`${board.id}:${board.version}:${board.state}`} board={board} />)}</ul>
    </section>}
    {panel === "feedback" && <section className="studio-feedback-panel studio-fixed-panel"><h2>访客反馈</h2><form className="studio-actions" method="get"><input type="hidden" name="panel" value="feedback" /><label>状态<select name="status" defaultValue={params.get("status") ?? ""}><option value="">全部</option>{Object.entries(FEEDBACK_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>搜索<input name="q" defaultValue={params.get("q") ?? ""} maxLength={200} /></label><button className="studio-compact-button">筛选反馈</button></form>
      <div className="studio-site-feedback-list studio-scroll-region"><ul>{data.feedback.rows.map(row => <FeedbackRow key={`${row.id}:${row.updated_at}`} row={row} />)}</ul>{!data.feedback.rows.length && <p className="studio-empty">没有符合条件的反馈。</p>}</div>
      <div className="studio-pagination studio-fixed-footer">{data.feedback.page > 1 && <Link to={`?panel=feedback&status=${encodeURIComponent(params.get("status") ?? "")}&q=${encodeURIComponent(params.get("q") ?? "")}&page=${data.feedback.page - 1}`}>上一页</Link>}<span>第{data.feedback.page}页</span>{data.feedback.rows.length === 50 && <Link to={`?panel=feedback&status=${encodeURIComponent(params.get("status") ?? "")}&q=${encodeURIComponent(params.get("q") ?? "")}&page=${data.feedback.page + 1}`}>下一页</Link>}</div>
    </section>}
  </section>;
}
