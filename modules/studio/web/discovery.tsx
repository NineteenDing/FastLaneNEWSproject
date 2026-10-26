import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TrendSignal } from "../contracts";

const platformNames: Record<string, string> = { bilibili: "B站", douyin: "抖音", kuaishou: "快手", weibo: "微博", xhs: "小红书", zhihu: "知乎", tieba: "贴吧", baidu: "百度" };
const statuses: Record<string, string> = { queued: "已排队", running: "处理中", ready: "已收录", awaiting_transcript: "作品已收录，正文待转写", failed: "未完成，可重试", interrupted: "处理已中断", login_required: "需要登录", rate_limited: "平台限流", not_checked: "尚未检查", ok: "检查成功", empty: "榜单为空", superseded: "线索已更新", pending_relevance: "待判断相关性", awaiting_deep_read: "相关，待取原文", excluded: "相关性不足，已归档", needs_verification: "待核实" };
function usePrivateRead<T>(path: string, polling = false) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, pending: AbortController | undefined;
    async function load() {
      const controller = new AbortController(); pending = controller;
      const deadline = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error("read failed");
        const next: T = await response.json(); if (active) { setData(next); setError(false); }
      } catch { if (active) setError(true); }
      finally { clearTimeout(deadline); pending = undefined; if (active && polling) timer = setTimeout(load, 10000); }
    }
    void load(); return () => { active = false; if (timer) clearTimeout(timer); pending?.abort(); };
  }, [path, revision, polling]);
  return { data, error, refresh };
}

type ImportItem = { id: string; platform: string; url: string; state: string; materialId: string | null; errorCode: string | null; retryVia: "trend_deep_read" | "single_content" };
function ContentImportPanel() {
  const read = usePrivateRead<{ rows: ImportItem[] }>("/api/admin/studio/content-imports", true), action = useAdminAction("studio-layout"), [url, setUrl] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); const result = await action.run("POST", "/api/admin/studio/content-imports", { url }, { success: "已提交作品读取", revalidate: false });
    if (result) { setUrl(""); read.refresh(); }
  }
  return <section aria-label="单条作品导入"><h2>添加一条参考作品</h2>
    <p className="studio-caption">支持B站、抖音、快手、微博、小红书作品，以及知乎具体回答或文章、贴吧帖子。小红书请保留分享参数。原文进入情报库，作者不会自动加入关注。</p>
    <form className="studio-filters" onSubmit={submit}><input type="url" aria-label="参考作品链接" placeholder="粘贴作品链接" maxLength={8000} value={url} onChange={event => setUrl(event.target.value)} required />
      <button disabled={action.busy} className="studio-primary">{action.busy ? "正在提交…" : "读取作品"}</button><button type="button" onClick={read.refresh}>刷新状态</button></form>
    {read.error && <p role="alert">作品状态暂时无法读取，请刷新重试。</p>}
    {!read.data && !read.error && <p role="status">正在读取导入记录…</p>}
    {read.data && <ul className="studio-discovery-list">{read.data.rows.slice(0, 20).map(item => <li key={item.id}><div><strong>{platformNames[item.platform]} · {item.errorCode === "no_representative" ? "本次搜索无候选，待核实" : statuses[item.state] ?? item.state}</strong>
      <p className="studio-caption"><a href={item.url} target="_blank" rel="noopener noreferrer">原始链接</a>{item.state === "ready" && " · 视频正文仍以字幕或转写处理结果为准"}</p></div>
      {item.materialId ? <Link to={`/admin/studio/intelligence/${encodeURIComponent(item.materialId)}`}>查看情报</Link>
        : !["queued", "running"].includes(item.state) && (item.retryVia === "trend_deep_read" ? <a href="#studio-trend-deep-read" onClick={() => document.getElementById("studio-trend-deep-read")?.setAttribute("open", "")}>前往热榜重试</a> : <button disabled={action.busy || item.platform === "xhs"} onClick={async () => {
          if (await action.run("POST", "/api/admin/studio/content-imports", { url: item.url, retryFailed: true }, { revalidate: false })) read.refresh();
        }}>重试</button>)}
      {item.platform === "xhs" && !item.materialId && !["queued", "running"].includes(item.state) && <span className="studio-caption">请重新粘贴完整分享链接并重试</span>}
    </li>)}</ul>}
  </section>;
}
type DeepReadSettings = { version: number; enabled: boolean; dailyLimit: number; usedToday: number; remainingToday: number; day: string; collectionEnabled: boolean };
function TrendDeepReadControls({ onSubmitted }: { onSubmitted: () => void }) {
  const read = usePrivateRead<DeepReadSettings>("/api/admin/studio/trends/deep-read-settings", true), action = useAdminAction("studio-layout");
  const [message, setMessage] = useState("");
  const value = read.data;
  async function submit(retryFailed: boolean) {
    const result = await action.run<{ queuedCount: number; limitedCount: number; awaitingRepresentativeCount: number }>("POST", "/api/admin/studio/trends/deep-read", { retryFailed }, { revalidate: false });
    if (result) {
      setMessage(`本次新排队 ${result.queuedCount} 条，额度不足暂缓 ${result.limitedCount} 条，待代表作品 ${result.awaitingRepresentativeCount} 条。`);
      read.refresh(); onSubmitted();
    }
  }
  return <section id="studio-trend-deep-read" className="studio-settings-panel" aria-label="取得热点原文"><h3>取得热点原文</h3>
    <p className="studio-caption">标题先由本地关键词筛选，不调用模型。相关热点自动尝试取得新闻原文；视频或登录平台再复用代表作品采集。取得正文后，沿普通新闻流程共享分析、公开和精选。</p>
    <p className="studio-caption">已关注博主优先处理。热榜每天按香港时间单独计额，新排队的线索占一个名额；同一线索重试与已收录作品复用不重复占额。B站直接读取榜单作品，其他已接入榜单通过话题搜索取得一条候选原文；候选仍需结合正文判断。</p>
    {read.error && <p role="alert">原文采集设置读取失败。<button onClick={read.refresh}>重试</button></p>}
    {!value && !read.error && <p role="status">正在读取每日名额…</p>}
    {value && <><p className="studio-caption">{value.day} · 已用 {value.usedToday} / {value.dailyLimit}，剩余 {value.remainingToday}。{!value.collectionEnabled && "采集尚未启用。"}</p>
      <form key={value.version} className="studio-filters" onSubmit={async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        if (await action.run("PUT", "/api/admin/studio/trends/deep-read-settings", { version: value.version, enabled: form.has("enabled"), dailyLimit: Number(form.get("dailyLimit")) }, { success: "代表作品采集额度已保存", revalidate: false })) read.refresh();
      }}><label><input type="checkbox" name="enabled" defaultChecked={value.enabled} /> 自动取得原文</label>
        <label>每天新增线索 <input type="number" name="dailyLimit" min={0} max={100} required defaultValue={value.dailyLimit} /></label>
        <button disabled={action.busy}>保存额度</button></form>
      <div className="studio-actions"><button disabled={action.busy || !value.enabled || !value.collectionEnabled} onClick={() => submit(false)}>处理相关线索</button>
        <button disabled={action.busy || !value.enabled || !value.collectionEnabled} onClick={() => submit(true)}>重试未完成的原文采集</button>
        <Link to="/admin/studio/intelligence?origin=trends">查看已取得的热榜情报</Link></div></>}
    {message && <p role="status">{message}</p>}
  </section>;
}
export function TrendSettingsPanel() {
  const [platform, setPlatform] = useState(""), [page, setPage] = useState(1), action = useAdminAction("studio-layout");
  const read = usePrivateRead<{ rows: TrendSignal[]; total: number; hasMore: boolean }>(`/api/admin/studio/trends/signals?limit=20&page=${page}${platform ? `&platform=${platform}` : ""}`, true);
  return <section className="studio-screen-list" aria-label="热榜发现"><div className="studio-page-header"><h2>热榜发现</h2><button onClick={read.refresh}>刷新线索</button></div>
    <p className="studio-caption">排名和原始热度只在同一平台内比较；未取得原文的标题不当作事实。全部线索保留相关性判断和处理去向。</p>
    <TrendDeepReadControls onSubmitted={read.refresh} />
    <div className="studio-filters"><select aria-label="热榜平台" value={platform} onChange={event => { setPlatform(event.target.value); setPage(1); }}><option value="">全部平台</option>{Object.entries(platformNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select>
      <button disabled={action.busy} onClick={() => action.run("POST", "/api/admin/studio/trends/relevance", {}, { success: "已提交新线索相关性判断", revalidate: false }).then(read.refresh)}>判断新线索</button>
      <button disabled={action.busy} onClick={() => action.run("POST", "/api/admin/studio/trends/relevance", { retryFailed: true }, { success: "已提交可恢复的判断", revalidate: false }).then(read.refresh)}>重试失败判断</button></div>
    {read.error && <p role="alert">热榜线索暂时无法读取，请刷新重试；已有记录保留。</p>}
    {!read.data && !read.error && <p role="status">正在读取热榜线索…</p>}
    {read.data && <><p className="studio-caption">共 {read.data.total} 条线索</p><div className="studio-page-content"><ul className="studio-discovery-list">{read.data.rows.map(signal => {
      const latest = signal.observations.at(-1), before = signal.observations.at(-2);
      return <li key={signal.id}><div><strong>{signal.title}</strong><p className="studio-caption">{platformNames[signal.platform]} · {latest ? `第${latest.rank}名${before ? `（上次第${before.rank}名）` : ""}${latest.rawHeat ? ` · 原始热度${latest.rawHeat}` : ""}` : "暂无观察"} · {statuses[signal.disposition] ?? signal.disposition}</p>
        {signal.relevance?.result && <p>{signal.relevance.result.reason}</p>}{signal.relevance?.error && <p role="status">{signal.relevance.error}</p>}
        {signal.deepRead && <p className="studio-caption">原文采集：{signal.deepRead.errorCode === "no_representative" ? "本次搜索无候选，待核实" : statuses[signal.deepRead.state] ?? "待处理"}{signal.deepRead.materialId && <> · <Link to={`/admin/studio/intelligence/${encodeURIComponent(signal.deepRead.materialId)}`}>查看情报</Link></>}</p>}</div>
        <a href={signal.url} target="_blank" rel="noopener noreferrer">原平台查看</a></li>;
    })}</ul>{!read.data.rows.length && <p className="studio-empty">当前没有线索。可在关注管理的“平台热榜”接入并启用榜单。</p>}</div>
      <div className="studio-pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第{page}页</span><button disabled={!read.data.hasMore} onClick={() => setPage(value => value + 1)}>下一页</button></div></>}
  </section>;
}
export function DiscoveryPanel({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="studio-discovery" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>热榜发现与补充参考作品</summary>
    {open && <><ContentImportPanel /><TrendSettingsPanel /></>}
  </details>;
}
