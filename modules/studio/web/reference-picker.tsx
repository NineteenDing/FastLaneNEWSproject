import { useEffect, useRef, useState } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { IntelligenceDetail, IntelligenceList, TopicRecommendations } from "../contracts";

type Material = TopicRecommendations["referenceMaterials"][number];
type ImportKind = "platform" | "news";
/** Reads the private library; explicit links use their durable platform/news import queue. */
export function ReferencePicker({ onAdd, onPendingChange, purpose = "writing" }: { onAdd(material: Material, role: "fact" | "expression"): void; onPendingChange?(pending: boolean): void; purpose?: "writing" | "work" }) {
  const [query, setQuery] = useState(""), [results, setResults] = useState<IntelligenceList | null>(null), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [linkKind, setLinkKind] = useState<ImportKind>("platform");
  const [pending, setPending] = useState<{ id: string; kind: ImportKind } | null>(null);
  const controller = useRef<AbortController | null>(null), mounted = useRef(true), action = useAdminAction("studio-layout");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { onPendingChange?.(busy || action.busy || !!pending); }, [busy, action.busy, pending, onPendingChange]);
  async function add(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/admin/studio/intelligence/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin", signal });
    if (!response.ok) throw new Error("材料详情未能读取，请稍后重试。");
    const material: IntelligenceDetail = await response.json();
    if (mounted.current && !signal?.aborted) { onAdd(material, material.kind === "news" ? "fact" : "expression"); setMessage(`已${purpose === "work" ? "选择" : "加入"}：${material.title}${purpose === "writing" && material.bodyState === "not_transcribed" ? "；需在情报库完成转写后再建立稿件" : ""}`); }
  }
  useEffect(() => {
    if (!pending) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(pending!.kind === "news" ? `/api/admin/studio/news-imports/${pending!.id}` : "/api/admin/studio/content-imports", { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!response.ok) throw new Error();
        type Item = { id: string; state: string; materialId: string | null };
        const result: Item | { rows: Item[] } = await response.json();
        const item = "rows" in result ? result.rows.find(item => item.id === pending!.id) : result;
        if (item?.materialId) { await add(item.materialId, abort.signal); if (!abort.signal.aborted) setPending(null); return; }
        if (item && !["queued", "running"].includes(item.state)) { if (!abort.signal.aborted) { setMessage(pending!.kind === "news" ? "新闻原稿读取未完成。请核对链接、网络或页面验证后重新点击读取；不会使用摘要代替正文。" : "作品读取未完成，请在情报库处理登录或失败后重试。"); setPending(null); } return; }
      } catch { if (!abort.signal.aborted) setMessage("作品状态暂不可读取，将重试；可先保留弹窗。"); }
      if (!abort.signal.aborted) timer = setTimeout(poll, 5000);
    }
    void poll(); return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [pending]);
  async function search() {
    if (busy || action.busy || pending) return;
    const value = query.trim(); if (!value) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setMessage("");
    try {
      if (/^https?:\/\//i.test(value)) {
        const kind = purpose === "writing" ? linkKind : "platform";
        const result = await action.run<{ item: { id: string; materialId: string | null } }>("POST", kind === "news" ? "/api/admin/studio/news-imports" : "/api/admin/studio/content-imports", { url: value, retryFailed: true }, { revalidate: false });
        if (result && !abort.signal.aborted) {
          if (result.item.materialId) await add(result.item.materialId, abort.signal);
          else { setPending({ id: result.item.id, kind }); setMessage(kind === "news" ? "新闻原稿已排队，正文读取完成后加入本稿；不会自动订阅这个网站。" : "作品已排队，读取完成后会加入这里；视频仍需完成字幕或转写。"); }
        }
      } else {
        if (value.length > 200) throw new Error("请使用200字以内的搜索关键词。");
        const response = await fetch(`/api/admin/studio/intelligence?q=${encodeURIComponent(value)}&limit=10${purpose === "work" ? "&origin=creators" : ""}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!response.ok) throw new Error("参考材料搜索暂不可用，请重试。");
        const next: IntelligenceList = await response.json(); if (!abort.signal.aborted) { setResults(next); if (!next.total) setMessage("没有匹配材料，可缩短关键词或使用作者名搜索。"); }
      }
    } catch (error) { if (!abort.signal.aborted && mounted.current) setMessage(error instanceof Error ? error.message : "操作未完成，请重试。"); }
    finally { if (!abort.signal.aborted && mounted.current) setBusy(false); }
  }
  return <details><summary>{purpose === "work" ? "添加同作品的其他发布" : "增加博主作品或新闻原稿"}</summary>
    <p className="studio-caption">{purpose === "work" ? "按作者、标题或正文搜索博主发布，也可先读取完整作品链接。请核对具体内容，只有相同作品才关联；讨论同一话题不代表同作品。选择后需保存关联。" : "搜索已收录的作者、标题或正文。粘贴链接时选择平台作品或新闻网页，读取完整原稿后加入参考。补充材料只加入本稿，不改变原批次。"}</p>
    <div className="studio-filters"><input aria-label={purpose === "work" ? "搜索同作品发布" : "搜索或导入参考材料"} placeholder="作者、内容关键词或作品链接" value={query} maxLength={8000} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} />
      {purpose === "writing" && <label>链接类型<select aria-label="链接类型" value={linkKind} disabled={busy || action.busy || !!pending} onChange={event => setLinkKind(event.target.value as ImportKind)}><option value="platform">平台作品</option><option value="news">新闻网页</option></select></label>}
      <button type="button" disabled={busy || action.busy || !!pending} onClick={() => void search()}>{busy ? "正在读取…" : "搜索或读取"}</button></div>
    <p className="studio-caption" role="status">{message}</p>
    {results && <ul className="studio-discovery-list">{results.rows.map(material => <li key={material.id}><div><strong>{material.title}</strong><p className="studio-caption">{material.source.name} · {material.excerpt}</p></div>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); void add(material.id).catch(error => setMessage(error.message)).finally(() => { if (mounted.current) setBusy(false); }); }}>{purpose === "work" ? "选择这条发布" : "加入参考"}</button></li>)}</ul>}
  </details>;
}
