import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { IntelligenceList, TopicColumn } from "../contracts";
import { Dialog } from "./dialog";
import { MaterialDialog } from "./material-dialog";
import { SourceAvatar } from "./material-reading";
import { isPlatformReference } from "./supplement-materials";

export type TopicSupplementScope = { startsAt: string; batchId?: string };
type ImportRow = { id: string; url: string; state: string; materialId: string | null; resultBatchId: string | null; error: string | null };
type ImportPage = { rows: ImportRow[]; total: number; page: number; limit: number };
const states: Record<string, string> = { queued: "等待后台处理", reading: "正在读取原文", waiting_transcript: "等待视频转写", waiting_cutoff: "等待原期次冻结后补入", applied: "已补入指定期次和栏目", failed: "需要处理后重试" };

/** A small selection surface over the existing library and durable scoped imports. */
export function TopicSupplements({ scope, column, onClose }: { scope: TopicSupplementScope; column: TopicColumn; onClose(): void }) {
  const [tab, setTab] = useState<"library" | "links">("library"), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [page, setPage] = useState(1);
  const [library, setLibrary] = useState<IntelligenceList | null>(null), [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [links, setLinks] = useState(""), [imports, setImports] = useState<ImportPage | null>(null), [importPage, setImportPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false), [readError, setReadError] = useState(""), [message, setMessage] = useState(""), [reading, setReading] = useState<string | null>(null), [resultId, setResultId] = useState<string | null>(null);
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  const close = () => { onClose(); void revalidator.revalidate(); };
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setLoading(true); setReadError("");
      try {
        const params = new URLSearchParams(tab === "library" ? { q: search, page: String(page), limit: "10" }
          : { startsAt: scope.startsAt, columnId: column.id, page: String(importPage) });
        const response = await fetch(`/api/admin/studio/${tab === "library" ? "intelligence" : "topic-supplement-imports"}?${params}`, {
          cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error("读取未完成，请检查登录或网络后刷新。");
        const data = await response.json();
        if (abort.signal.aborted) return;
        if (tab === "library") setLibrary(data as IntelligenceList);
        else {
          setImports(data as ImportPage);
          if ((data as ImportPage).rows.some(row => !["applied", "failed"].includes(row.state))) timer = setTimeout(load, 5000);
        }
      } catch (error) {
        if (!abort.signal.aborted) { setReadError(error instanceof Error ? error.message : "读取未完成，请重试。"); if (tab === "links") timer = setTimeout(load, 10000); }
      } finally { if (!abort.signal.aborted) setLoading(false); }
    }
    void load(); return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [tab, search, page, scope.startsAt, column.id, importPage, refresh]);

  async function addSelected() {
    if (action.busy || !selected.size) return;
    const result = await action.run<{ batchId?: string }>("POST", `/api/admin/studio/topic-batches/${scope.batchId ?? "current"}/supplements`, {
      columnId: column.id, materialIds: [...selected.keys()], ...(!scope.batchId ? { startsAt: scope.startsAt } : {}),
    }, { revalidate: false });
    if (result) { setMessage(`已补充 ${selected.size} 条材料。模型允许且后台运行时，会自动更新选题并审核；已建立的稿件不变。`); setSelected(new Map()); setResultId(result.batchId ?? null); }
  }
  async function addLinks() {
    if (action.busy) return;
    const urls = [...new Set(links.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
    if (!urls.length || urls.length > 20) { setMessage("请每行粘贴一条完整链接，每批1–20条。"); return; }
    const rows: { url: string; kind: "news" | "creator" }[] = [];
    try {
      for (const value of urls) {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 8000) throw new Error();
        rows.push({ url: url.href, kind: isPlatformReference(url.hostname) ? "creator" : "news" });
      }
    } catch { setMessage("链接格式不正确，请使用完整的HTTP或HTTPS链接，小红书请保留分享参数。"); return; }
    const result = await action.run<{ rows: ImportRow[] }>("POST", "/api/admin/studio/topic-supplement-imports", { ...scope, columnId: column.id, links: rows }, { revalidate: false });
    if (result) { setMessage("链接已保存到本期本栏。关闭页面后后台继续处理；失败项可单独重试。"); setLinks(""); setImportPage(1); setRefresh(value => value + 1); }
  }
  async function retry(id: string) {
    if (action.busy) return;
    if (await action.run("POST", `/api/admin/studio/topic-supplement-imports/${id}/retry`, {}, { revalidate: false })) setRefresh(value => value + 1);
  }
  const updated = resultId ?? imports?.rows.find(row => row.resultBatchId)?.resultBatchId;
  return <Dialog title={`增加新闻来源 · ${column.name}`} onClose={close} wide>
    <p className="studio-caption">为本期的这个栏目补充单篇内容，不会自动关注网站或博主。已截止的选题会保留原版，另建修订。</p>
    <nav className="studio-tabs studio-topic-supplement-tabs" aria-label="补充方式"><button type="button" aria-pressed={tab === "library"} onClick={() => { setTab("library"); setMessage(""); }}>从情报库选择</button>
      <button type="button" aria-pressed={tab === "links"} onClick={() => { setTab("links"); setMessage(""); }}>批量粘贴链接</button></nav>
    {message && <p role="status" className="studio-notice">{message}</p>}
    {updated && <p><Link to={`/admin/studio/topics?view=history&batch=${encodeURIComponent(updated)}`} onClick={onClose}>查看更新后的选题</Link><span className="studio-caption">（处理中会显示实际进度）</span></p>}
    {tab === "library" ? <>
      <form className="studio-filters" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setPage(1); setRefresh(value => value + 1); }}>
        <label>搜索全部材料<input aria-label="搜索补充材料" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="新闻、作者、标题或正文关键词" /></label><button type="submit" disabled={loading}>搜索</button>
      </form>
      <div className="studio-actions studio-topic-supplement-summary"><span className="studio-caption">已选 {selected.size} / 50 条</span>
        <button type="button" disabled={!selected.size || action.busy} onClick={() => setSelected(new Map())}>清空选择</button>
        <button type="button" className="studio-primary" disabled={!selected.size || action.busy} onClick={() => void addSelected()}>{action.busy ? "正在补充…" : "补充到本栏并更新选题"}</button></div>
      {library && <ul className="studio-topic-supplement-library">{library.rows.map(item => <li key={item.id}>
        <label><input type="checkbox" checked={selected.has(item.id)} disabled={action.busy || !selected.has(item.id) && selected.size >= 50} onChange={event => setSelected(previous => { const next = new Map(previous); if (event.target.checked) next.set(item.id, item.title); else next.delete(item.id); return next; })} aria-label={`选择：${item.title}`} />
          <SourceAvatar source={item.source} /><span><strong>{item.title}</strong><span className="studio-caption">{item.source.name} · {item.excerpt || "暂无简介，可查看正文。"}</span></span></label>
        <button type="button" onClick={() => setReading(item.id)}>查看内容</button>
      </li>)}</ul>}
      {library && !library.total && <p className="studio-caption">暂无匹配材料。可调整关键词，或切换到批量粘贴链接。</p>}
      {library && <nav className="studio-pagination" aria-label="补充材料分页"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页 · 共 {library.total} 条</span><button type="button" disabled={!library.hasMore || loading} onClick={() => setPage(value => value + 1)}>下一页</button></nav>}
      <p className="studio-caption">选择会保留到提交，可跨页勾选。视频需先在情报库完成转写，不会用简介冒充正文。</p>
    </> : <>
      <label>新闻或七平台作品链接<textarea aria-label="栏目批量参考链接" rows={5} maxLength={160000} value={links} onChange={event => setLinks(event.target.value)} placeholder="每行一条完整链接，小红书保留分享参数" /></label>
      <div className="studio-actions"><button type="button" className="studio-primary" disabled={action.busy || !links.trim()} onClick={() => void addLinks()}>{action.busy ? "正在保存…" : "读取并补充本栏"}</button><button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新进度</button></div>
      <ul className="studio-import-results">{imports?.rows.map(row => <li key={row.id}><div><a href={/^https?:\/\//i.test(row.url) ? row.url : undefined} target="_blank" rel="noopener noreferrer">{row.url}</a>
        <p className="studio-caption" role="status">{states[row.state] ?? "状态待确认"}{row.error ? ` · ${row.error}` : ""}</p></div>
        {row.materialId && <button type="button" onClick={() => setReading(row.materialId)}>查看内容</button>}{row.state === "failed" && <button type="button" disabled={action.busy} onClick={() => void retry(row.id)}>重试这条</button>}</li>)}</ul>
      {imports && !imports.total && <p className="studio-caption">本期本栏尚未提交链接。</p>}
      {imports && imports.total > imports.limit && <nav className="studio-pagination" aria-label="栏目导入分页"><button type="button" disabled={importPage <= 1 || loading} onClick={() => setImportPage(value => value - 1)}>上一页</button><span>第 {importPage} 页 · 共 {imports.total} 条</span><button type="button" disabled={importPage * imports.limit >= imports.total || loading} onClick={() => setImportPage(value => value + 1)}>下一页</button></nav>}
    </>}
    {loading && <p role="status" className="studio-caption">正在读取…</p>}
    {readError && <p role="alert">{readError} <button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></p>}
    {reading && <MaterialDialog key={reading} id={reading} onClose={() => setReading(null)} />}
  </Dialog>;
}
