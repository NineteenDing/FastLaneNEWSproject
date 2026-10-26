import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { SourceCoveragePage, SourceCoverageRow } from "../contracts";

const labels: Record<SourceCoverageRow["state"], string> = { paused: "已暂停", not_checked: "本窗口尚无成功检查", checked: "本窗口已成功检查", partial: "已检查，作品分页待续", running: "采集记录处理中", failed: "最近检查失败", login_required: "需要重新登录", rate_limited: "平台限流", interrupted: "采集已中断", after_window: "最近成功检查在窗口之后" };
const kinds = { news: "新闻源", creator: "博主", trend: "热榜" };
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const date = (value: string | null) => value ? clock.format(new Date(value)) : "尚无记录";

/** Read on demand; failures leave the last readable page intact and never launch collection. */
export function TopicSourceCoverage({ batchId }: { batchId?: string }) {
  const [value, setValue] = useState<SourceCoveragePage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { const previous = active.current; active.current = null; previous?.abort(); }, []);
  async function load(page = 1) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/admin/studio/topic-batches/${batchId ? encodeURIComponent(batchId) : "current"}/coverage?page=${page}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const result: SourceCoveragePage = await response.json();
      if (!controller.signal.aborted) setValue(result);
    } catch { if (active.current === controller) setError("来源检查记录未能加载，请重试；已显示的记录仍保留。"); }
    finally { clearTimeout(deadline); if (active.current === controller) { setBusy(false); active.current = null; } }
  }
  const counts = value?.counts;
  const attention = counts ? counts.failed + counts.login_required + counts.rate_limited + counts.interrupted + counts.running : 0;
  return <section className="studio-topic-directions" aria-labelledby="source-coverage-title">
    <h2 id="source-coverage-title">来源检查与覆盖</h2>
    <details className="studio-batch-rules" onToggle={event => { if (event.currentTarget.open && !value && !busy) void load(); }}>
      <summary>查看来源检查与分页缺口</summary>
      <p className="studio-caption">{batchId ? "查看截止时保存的来源清单与检查记录；后续改名或取消关注不改变这份记录。" : "查看当前已配置的新闻源、热榜与关注博主；打开或刷新不会启动采集。"}</p>
      <div className="studio-actions"><button type="button" disabled={busy} onClick={() => void load(value?.page ?? 1)}>{busy ? "正在读取…" : "刷新检查记录"}</button></div>
      {error && <p className="studio-notice" role="alert">{error}</p>}
      {value?.state === "unavailable" ? <p>这个旧批次没有保存来源检查快照，不能用当前关注列表替代。</p> : value && <>
        <p className="studio-caption">{value.total} 个来源 · 成功检查 {counts!.checked} · 作品分页待续 {counts!.partial} · 尚未检查 {counts!.not_checked} · 异常或处理中 {attention} · 已暂停 {counts!.paused} · 窗口后检查 {counts!.after_window}</p>
        <p className="studio-caption">记录时间：{date(value.capturedAt)} · 香港时间。按最后保存的检查状态统计；成功检查不代表全部历史内容或评论均已取得。</p>
        {value.rows.length ? <ul className="studio-batch-list" aria-label="来源检查记录">{value.rows.map(row => <li key={row.id}>
          <Link to={row.kind === "creator" ? `/admin/studio/creators/${encodeURIComponent(row.id.slice(8))}` : `/admin/studio/following?q=${encodeURIComponent(row.id.slice(5))}`}><strong>{row.name}</strong></Link>
          <p>{kinds[row.kind]} · {labels[row.state]}</p>
          <p className="studio-caption">最近成功检查：{date(row.lastCheckedAt)} · 最近尝试：{date(row.lastAttemptAt)}</p>
          {row.page !== null && <p className="studio-caption">作品列表最近处理第 {row.page} 页；{row.nextPage !== null ? `待续第 ${row.nextPage} 页` : row.pagesComplete ? "本次列表已到末页" : "分页完整性未知"}。评论范围在对应情报中查看。</p>}
        </li>)}</ul> : <p className="studio-caption">尚无已配置来源，可前往关注管理添加。</p>}
        <nav className="studio-pagination" aria-label="来源检查分页"><button disabled={busy || value.page <= 1} onClick={() => void load(value.page - 1)}>上一页</button><span>第 {value.page} 页</span><button disabled={busy || !value.hasMore} onClick={() => void load(value.page + 1)}>下一页</button></nav>
      </>}
    </details>
  </section>;
}
