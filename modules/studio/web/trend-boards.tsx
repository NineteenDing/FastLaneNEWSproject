import { useEffect, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TrendBoards, TrendSignal, TrendPlatform } from "../contracts";
import { FollowingTabs } from "./following-tabs";
import { SourceAvatar } from "./source-avatar";
import { Dialog } from "./dialog";

export const loader = ({ request }: LoaderFunctionArgs) => adminGet<TrendBoards>(request, "/api/admin/studio/trends/boards");
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: `平台热榜 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];

function BoardContents({ platform, full = false }: { platform: TrendPlatform; full?: boolean }) {
  const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false);
  const [rows, setRows] = useState<TrendSignal[] | null>(null), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setFailed(false); setRows(null);
    void fetch(`/api/admin/studio/trends/signals?platform=${platform}&current=true&limit=${full ? 20 : 10}&page=${page}`, { credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }).then(async response => {
      if (!response.ok) throw new Error();
      const result = await response.json() as { rows: TrendSignal[]; hasMore: boolean }; if (!controller.signal.aborted) { setRows(result.rows); setHasMore(result.hasMore); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [platform, revision, page, full]);
  return <div className={full ? "studio-board-content studio-fixed-panel" : "studio-board-content"}>
    <div className={full ? "studio-scroll-region" : undefined}>{failed ? <p role="alert">榜单暂不可读。<button onClick={() => setRevision(value => value + 1)}>重试</button></p> : rows === null ? <p role="status">正在读取榜单…</p> : rows.length ? <ol>
      {rows.map(row => { const observation = row.observations.at(-1); return <li key={row.id}>
        <span className="studio-caption">{observation?.rank ?? "—"}</span><a href={row.url} target="_blank" rel="noopener noreferrer">{row.title}</a>
        {observation?.rawHeat && <span className="studio-caption">热度 {observation.rawHeat}</span>}
      </li>; })}</ol> : <p className="studio-caption">暂无已保存榜单，启用后等待后台检查。</p>}</div>
    {full && <div className="studio-pagination studio-fixed-footer"><button disabled={page <= 1 || rows === null} onClick={() => setPage(p => p - 1)}>上一页</button><span>第{page}页</span><button disabled={!hasMore || rows === null} onClick={() => setPage(p => p + 1)}>下一页</button></div>}
    </div>;
}

function BoardCard({ board }: { board: TrendBoards["rows"][number] }) {
  const action = useAdminAction("studio-layout"), [open, setOpen] = useState(false);
  const enabled = !!board.source?.enabled && !board.source.archived;
  async function toggle() {
    if (!board.connected) await action.run("POST", `/api/admin/studio/trends/boards/${board.platform}`, { enabled: true,
      ...(board.source ? { sourceVersion: board.source.version } : {}) }, { success: "榜单已启用" });
    else if (board.source) await action.run("PATCH", `/api/admin/studio/news-sources/${encodeURIComponent(board.source.id)}/status`,
      { version: board.source.version, enabled: !enabled }, { success: enabled ? "榜单已暂停" : "榜单已启用" });
  }
  return <article className="studio-source studio-board" aria-label={board.name}>
    <header><a href={board.homepage} target="_blank" rel="noopener noreferrer" aria-label={`打开${board.name}`}><SourceAvatar name={board.name} src={null} /></a>
      <div><h2>{board.name}</h2><p className="studio-caption">{!board.supported ? "暂未支持" : enabled ? "已启用" : "未启用"}</p></div>
      {!board.source?.archived && <button className="studio-slide-switch" role="switch" aria-checked={enabled} aria-label={`启用${board.name}`} disabled={action.busy || !board.supported} onClick={toggle}><span aria-hidden="true" /></button>}</header>
    <p className="studio-caption studio-board-status">{board.collection ? board.collection.state === "ready" ? `最近取得 ${board.collection.itemCount ?? 0} 条`
      : board.collection.state === "running" ? "检查中" : board.collection.state === "failed" ? "最近检查失败" : "等待检查" : "尚未检查"}
      {board.collection?.checkedAt && <> · {new Date(board.collection.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong" })}</>}</p>
    {board.source?.archived && <Link to="/admin/studio/following?archived=true">前往已移除来源恢复</Link>}
    {board.unsupportedReason && <p className="studio-caption">{board.unsupportedReason}</p>}
    <p className="studio-caption">仅供分享学习使用，<a href={board.homepage} target="_blank" rel="noreferrer">官方完整榜单请点击直达原站</a>。</p>
    {board.supported && <><BoardContents platform={board.platform} /><button onClick={() => setOpen(true)}>查看完整榜单</button></>}
    {open && <Dialog title={board.name + " · 完整榜单"} onClose={() => setOpen(false)} wide><BoardContents platform={board.platform} full /></Dialog>}
  </article>;
}

export default function TrendBoardsPage() {
  const boards = useLoaderData<typeof loader>();
  return <><header className="studio-page-header"><div><h1>关注管理</h1><p>热榜作为新闻来源，辅助判断话题热度。</p></div>
    <Link className="studio-button" to="/admin/studio/settings/trends">热榜采集设置</Link></header><FollowingTabs active="trends" />
    {!boards.collectionEnabled && <p className="studio-notice">后台采集尚未启动；可以先选择要启用的榜单。</p>}
    <div className="studio-source-grid">{boards.rows.map(board => <BoardCard key={board.platform} board={board} />)}</div></>;
}
