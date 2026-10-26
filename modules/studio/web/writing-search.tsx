import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { WritingProjectPage } from "../contracts";
import { SearchText } from "./intelligence-search";

export function WritingSearch({ initial = "" }: { initial?: string }) {
  const [query, setQuery] = useState(initial), [open, setOpen] = useState(false), [result, setResult] = useState<WritingProjectPage | null>(null), [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!query.trim()) { setResult(null); setError(""); return; }
    const controller = new AbortController(); setResult(null); setError("");
    const timer = setTimeout(() => { void fetch(`/api/admin/studio/drafts?${new URLSearchParams({ q: query.trim(), limit: "8" })}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<WritingProjectPage>; })
      .then(value => { if (!controller.signal.aborted) setResult(value); }).catch(() => { if (!controller.signal.aborted) setError("搜索失败，请重新输入或稍后重试。"); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <div className="studio-writing-search" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label>搜索全部稿件<input name="q" type="search" autoComplete="off" maxLength={200} value={query} placeholder="标题、正文、引用来源" onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }} aria-expanded={open && !!query.trim()} aria-controls="writing-search-results" /></label>
    {open && !!query.trim() && <div id="writing-search-results" className="studio-writing-search-results" role="region" aria-label="稿件搜索结果">
      {error ? <p role="alert">{error}</p> : !result ? <p role="status">搜索中…</p> : !result.rows.length ? <p>没有匹配的稿件。</p> : <>
        <p className="studio-caption">全库匹配 {result.total} 篇，显示前8篇</p>{result.rows.map(project => {
          const fields = [project.content.spoken, project.content.production, project.content.notes];
          const body = fields.find(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || fields.find(Boolean) || "尚未填写正文", index = body.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
          const excerpt = body.slice(Math.max(0, index - 35), Math.max(0, index - 35) + 180);
          return <Link key={project.id} to={`/admin/studio/writing/${project.id}`}><strong><SearchText text={project.title} query={query} /></strong><p><SearchText text={excerpt} query={query} /></p>
            <span className="studio-caption"><SearchText text={[...new Set(project.snapshot.materials.map(item => item.source.name))].join("、")} query={query} /></span>
            {project.snapshot.materials.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 3).map(item => <p className="studio-caption" key={item.id}>引用：<SearchText text={item.title} query={query} /></p>)}</Link>;
        })}
      </>}
    </div>}
  </div>;
}
