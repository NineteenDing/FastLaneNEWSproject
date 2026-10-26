import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { TopicBatchPage } from "../contracts";

/** The archive is browsed by month; more server pages load inside this rail. */
export function BatchTimeline({ initial, selected, href, query = "", draftsOnly = false }: {
  initial: TopicBatchPage; selected?: string | null; href(id: string): string; query?: string; draftsOnly?: boolean;
}) {
  const [list, setList] = useState(initial), [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const rail = useRef<HTMLElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const previousQuery = useRef(query);
  useEffect(() => {
    const changed = previousQuery.current !== query;
    previousQuery.current = query;
    setList(old => changed ? initial : { ...initial, page: Math.max(old.page, initial.page), hasMore: old.page > initial.page ? old.hasMore : initial.hasMore, rows: [...initial.rows, ...old.rows.filter(row => !initial.rows.some(next => next.id === row.id))] });
    setError(false); setLoading(false);
  }, [initial, query]);
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || !list.hasMore || pending || error) return;
      pending = true;
      setLoading(true);
      const params = new URLSearchParams(query); params.set("page", String(list.page + 1)); params.set("limit", "30");
      void fetch(`/api/admin/studio/topic-batches?${params}`, { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<TopicBatchPage>; })
        .then(next => { if (!controller.signal.aborted) setList(old => ({ ...next, rows: [...old.rows, ...next.rows.filter(row => !old.rows.some(existing => existing.id === row.id))] })); })
        .catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { pending = false; if (!controller.signal.aborted) setLoading(false); });
    }, { root: rail.current, rootMargin: "120px" });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => { controller.abort(); observer.disconnect(); };
  }, [list.page, list.hasMore, error, query]);
  const groups = new Map<string, typeof list.rows>();
  for (const batch of list.rows.toSorted((a, b) => b.startsAt.localeCompare(a.startsAt))) {
    if (draftsOnly && !batch.draftCount) continue;
    const month = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).format(new Date(batch.startsAt));
    groups.set(month, [...(groups.get(month) ?? []), batch]);
  }
  const latest = [...groups.keys()][0], chosenMonth = [...groups].find(([, rows]) => rows.some(row => row.id === selected))?.[0];
  return <aside ref={rail} className="studio-batch-timeline" aria-label="历史期次日期">
    {[...new Set([...groups.keys()].map(key => key.slice(0, 4)))].map(year => <details open key={year}><summary>{year} 年</summary>
      {[...groups].filter(([key]) => key.startsWith(year)).map(([key, rows]) => <details key={key} open={key === (chosenMonth ?? latest)}><summary>{Number(key.slice(5))} 月</summary>
        <ul>{rows.map(batch => <li key={batch.id}><Link to={href(batch.id)} aria-current={selected === batch.id ? "page" : undefined}>
          <strong>{new Date(batch.startsAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Hong_Kong", month: "2-digit", day: "2-digit" })} — {new Date(batch.endsAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Hong_Kong", month: "2-digit", day: "2-digit" })}</strong>
          <span className="studio-caption">稿件 {batch.draftCount} · 已确认 {batch.finalizedDraftCount ?? 0}</span></Link></li>)}</ul>
      </details>)}
    </details>)}
    {!groups.size && !list.hasMore && <p>暂无历史期次。</p>}
    <div ref={sentinel}>{loading ? "正在读取更多期次…" : error ? <button onClick={() => setError(false)}>重新读取期次</button> : ""}</div>
  </aside>;
}
