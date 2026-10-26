import { useEffect, useState, useRef, type ReactNode } from "react";
import type { LanguageSample, LanguageSamplePage, TopicColumn } from "../contracts";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });

export function LanguageSampleEntries({ samples, columns }: { samples: LanguageSample[]; columns: TopicColumn[] }) {
  return <div className="studio-language-samples">{samples.map(sample => <article key={`${sample.projectId}:${sample.version}`}>
    <h3><strong>{sample.title}</strong><span className="studio-caption">确认版本 {sample.version} · {sample.columnIds.map(id => columns.find(column => column.id === id)?.name ?? id).join(" / ")}</span></h3>
    <p className="studio-caption">确认于 {clock.format(new Date(sample.confirmedAt))} · 香港时间。以下为保存的样本版本，来源稿可能已有后续修改。</p>
    <p className="studio-language-sample-body">{sample.spoken}</p>
    <a href={`/admin/studio/writing/${encodeURIComponent(sample.projectId)}`} target="_blank" rel="noopener noreferrer">另页打开来源稿</a>
  </article>)}</div>;
}

export function LanguageSampleSettings({ columns, children, active = true }: { columns: TopicColumn[]; children?: ReactNode; active?: boolean }) {
  const [pane, setPane] = useState("samples"), region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const measure = () => { const node = region.current; if (node) node.style.setProperty("--studio-learning-height", `${Math.max(320, innerHeight - node.getBoundingClientRect().top - 24)}px`); };
    const frame = requestAnimationFrame(measure); window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", measure); };
  }, [active]);
  const [columnId, setColumnId] = useState(""), [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const key = `${columnId}:${page}`;
  const [response, setResponse] = useState<{ key: string; result?: LanguageSamplePage; error?: string } | null>(null);
  const current = response?.key === key ? response : null, report = current?.result;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), query = new URLSearchParams({ page: String(page), limit: "10" });
    if (columnId) query.set("columnId", columnId);
    setResponse({ key });
    void (async () => {
      try {
        const result = await fetch(`/api/admin/studio/language-samples?${query}`, { credentials: "same-origin", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!result.ok) throw new Error("unavailable");
        const data = await result.json() as LanguageSamplePage;
        if (!controller.signal.aborted) setResponse({ key, result: data });
      } catch { if (!controller.signal.aborted) setResponse({ key, error: "样本暂时无法读取，请重试。其他设置保持不变。" }); }
    })();
    return () => controller.abort();
  }, [active, columnId, page, key, retry]);
  return <div ref={region} className="studio-learning-layout"><nav className="studio-learning-mobile-tabs" aria-label="语言库视图"><button aria-current={pane === "samples" ? "page" : undefined} onClick={() => setPane("samples")}>确认样本</button><button aria-current={pane === "learning" ? "page" : undefined} onClick={() => setPane("learning")}>规则学习</button></nav><section data-mobile-hidden={pane !== "samples" || undefined} className="studio-session-settings studio-learning-panel" aria-labelledby="language-samples-title"><h2 id="language-samples-title">栏目语言库</h2>
    <p className="studio-caption">确认定稿或定稿导出后积累样本，普通保存不会加入。新稿最多参考本栏目 3 份完整样本，只借鉴表达，不沿用旧事实。</p>
    <section className="studio-panel-page" aria-label="栏目确认样本">
      <div className="studio-actions"><label>样本栏目<select aria-label="样本栏目" value={columnId} onChange={event => { setColumnId(event.target.value); setPage(1); }}>
        <option value="">全部栏目</option>{columns.map(column => <option key={column.id} value={column.id}>{column.name}{column.enabled ? "" : "（已停用）"}</option>)}</select></label>
        <button type="button" className="studio-small-red" onClick={() => setRetry(value => value + 1)}>刷新样本</button></div>
      <div className="studio-page-content" aria-live="polite">{!report && !current?.error && <p className="studio-caption" role="status">正在读取样本…</p>}
        {current?.error && <p className="studio-notice" role="alert">{current.error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试加载</button></p>}
        {report && <><p className="studio-caption">共 {report.total} 份确认样本 · 第 {report.page} 页。重复定稿导出不会重复计数。</p>
          {report.rows.length ? <LanguageSampleEntries samples={report.rows} columns={columns} /> : <p className="studio-caption">当前栏目还没有确认样本。可以在写稿台确认一篇定稿后再查看。</p>}
          </>}
      </div>
      <nav className="studio-pagination" aria-label="栏目样本分页"><button type="button" disabled={!report || report.page <= 1} onClick={() => setPage(value => value - 1)}>上一页样本</button><span>第 {page} 页</span>
        <button type="button" disabled={!report?.hasMore} onClick={() => setPage(value => value + 1)}>下一页样本</button></nav>
    </section>
  </section><div className="studio-learning-right" data-mobile-hidden={pane !== "learning" || undefined}>{children}</div></div>;
}
