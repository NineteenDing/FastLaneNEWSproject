import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { Dialog } from "./dialog";
import { MaterialDialog } from "./material-dialog";

type ImportRow = { url: string; kind: "news" | "platform"; id?: string; state: string; materialId: string | null };
const platformHost = /(^|\.)(bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|kuaishou\.com|gifshow\.com|weibo\.com|weibo\.cn|xiaohongshu\.com|xhslink\.com|zhihu\.com|tieba\.baidu\.com)$/i;
export const isPlatformReference = (hostname: string) => platformHost.test(hostname);
const pendingStates = new Set(["queued", "running"]);
const stateNames: Record<string, string> = { submitting: "正在提交", queued: "已排队", running: "正在读取", ready: "已收录", awaiting_transcript: "已收录，等待转写", failed: "读取未完成，可重试", interrupted: "处理中断，可重试", login_required: "需要平台登录", rate_limited: "平台限流" };

/** Batch entry is a thin client of the existing durable imports; each result keeps its own retry/identity. */
export function SupplementMaterials() {
  const [open, setOpen] = useState(false), [text, setText] = useState(""), [rows, setRows] = useState<ImportRow[]>([]);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [reading, setReading] = useState<string | null>(null);
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator(), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(urls: string[]) {
    if (busy) return; setBusy(true); setMessage("");
    for (const url of urls) {
      if (!mounted.current) break;
      const kind = isPlatformReference(new URL(url).hostname) ? "platform" : "news";
      setRows(current => [...current.filter(row => row.url !== url), { url, kind, state: "submitting", materialId: null }]);
      const result = await action.run<{ item: { id: string; state: string; materialId: string | null } }>("POST", kind === "news" ? "/api/admin/studio/news-imports" : "/api/admin/studio/content-imports", { url, retryFailed: true }, { revalidate: false });
      if (!mounted.current) break;
      setRows(current => current.map(row => row.url === url ? { ...row, ...(result ? { id: result.item.id, state: result.item.state, materialId: result.item.materialId } : { state: "failed" }) } : row));
      if (result?.item.materialId) revalidator.revalidate();
    }
    if (mounted.current) setBusy(false);
  }
  function addLinks() {
    if (busy) return;
    const links = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!links.length || links.length > 20) { setMessage("每行一条链接，每批1–20条。"); return; }
    const urls: string[] = [];
    try { for (const link of links) { const url = new URL(link); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 8000) throw new Error(); urls.push(url.href); } }
    catch { setMessage("有链接格式不正确，请每行粘贴一个完整的HTTP或HTTPS地址。"); return; }
    const unique = [...new Set(urls)], ready = new Set(rows.filter(row => !!row.materialId || pendingStates.has(row.state)).map(row => row.url));
    const remaining = unique.filter(url => !ready.has(url));
    if (!remaining.length) { setMessage("这些链接已收录或正在处理，未重复提交。"); return; }
    void submit(remaining);
  }
  const waiting = rows.filter(row => row.id && !row.materialId && pendingStates.has(row.state));
  const pendingKey = waiting.map(row => `${row.kind}:${row.id}`).join(",");
  useEffect(() => {
    if (!open || !pendingKey) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      let changed = false;
      for (const row of waiting) {
        if (controller.signal.aborted) break;
        try {
          const response = await fetch(row.kind === "news" ? `/api/admin/studio/news-imports/${row.id}` : "/api/admin/studio/content-imports", {
            cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
          if (!response.ok) throw new Error();
          const value = await response.json(); const item = row.kind === "news" ? value : value.rows.find((item: { id: string }) => item.id === row.id);
          if (item && !controller.signal.aborted) {
            setRows(current => current.map(existing => existing.url === row.url && existing.id === row.id ? { ...existing, state: item.state, materialId: item.materialId } : existing));
            if (item.materialId) changed = true;
          }
        } catch { if (!controller.signal.aborted) setMessage("状态暂时读取失败，将自动重试，后台任务继续保留。"); }
      }
      if (!controller.signal.aborted) { if (changed) revalidator.revalidate(); timer = setTimeout(poll, 5000); }
    }
    void poll(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, pendingKey]);
  return <><button type="button" onClick={() => setOpen(true)}>补充参考作品</button>{open && <Dialog title="补充参考作品" onClose={() => setOpen(false)}>
    <p className="studio-caption">粘贴新闻网页或七平台作品链接，每行一条，每批最多20条。重复内容复用已有记录，不自动关注作者或网站。关闭窗口后已提交任务继续处理。</p>
    <label>参考链接<textarea aria-label="批量参考链接" rows={6} maxLength={160000} value={text} onChange={event => setText(event.target.value)} placeholder="https://…&#10;https://…" /></label>
    <div className="studio-actions"><button type="button" className="studio-primary" disabled={busy} onClick={addLinks}>{busy ? "正在提交…" : "读取并入库"}</button></div>
    {message && <p role="status">{message}</p>}
    <ul className="studio-import-results">{rows.map(row => <li key={row.url}><div><a href={row.url} target="_blank" rel="noopener noreferrer">{row.url}</a><p className="studio-caption" role="status">{stateNames[row.state] ?? "状态待确认"}</p></div>
      {row.materialId ? <button type="button" onClick={() => setReading(row.materialId)}>查看内容</button> : !pendingStates.has(row.state) && row.state !== "submitting" && <button type="button" disabled={busy} onClick={() => void submit([row.url])}>重试这条</button>}</li>)}</ul>
  </Dialog>}{reading && <MaterialDialog key={reading} id={reading} onClose={() => setReading(null)} />}</>;
}
