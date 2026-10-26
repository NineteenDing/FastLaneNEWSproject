import { useState } from "react";
import type { StudioSiteRelease } from "../site-management-contracts";

/** Edit one record, saving through the existing site version check. */
export function ReleaseTimeline({ rows, busy, save }: { rows: StudioSiteRelease[]; busy: boolean; save(rows: StudioSiteRelease[]): Promise<boolean> }) {
  const ordered = rows.toSorted((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", dateStyle: "short", timeStyle: "short" }).format(new Date()).split(" ");
  const [month, setMonth] = useState(ordered[0]?.date.slice(0, 7) ?? today()[0]!.slice(0, 7));
  const [draft, setDraft] = useState<StudioSiteRelease | null>(null);
  const change = (value: Partial<StudioSiteRelease>) => setDraft(row => row ? { ...row, ...value } : row);
  function select(row: StudioSiteRelease | null) {
    if (draft && JSON.stringify(draft) !== JSON.stringify(rows.find(row => row.id === draft.id)) && !window.confirm("放弃本次尚未保存的日志修改？")) return;
    setDraft(row ? structuredClone(row) : null);
  }
  return <section className="studio-release-timeline">
    <div className="studio-actions"><button type="button" disabled={busy} onClick={() => {
      const [date, time] = today();
      select({ id: crypto.randomUUID(), date: date!, time: time!, kind: "更新", title: "", body: [""], published: false });
    }}>新建日志</button><label>查看月份<input aria-label="日志月份" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label></div>
    <div className="studio-release-layout">
      <aside className="studio-scroll-region" aria-label="日志时间轴"><ol>{ordered.filter(row => row.date.startsWith(month)).map(row => <li key={row.id}>
        <button type="button" aria-current={draft?.id === row.id ? "true" : undefined} onClick={() => select(row)}><time>{row.date} {row.time}</time><strong>{row.title}</strong><span>{row.published ? "已公开" : "草稿"}</span></button>
      </li>)}</ol>{!ordered.some(row => row.date.startsWith(month)) && <p className="studio-caption">这个月暂无已保存日志。</p>}</aside>
      <div className="studio-scroll-region">{draft ? <form className="studio-site-form" onSubmit={e => { e.preventDefault(); void (async () => {
        const next = [...rows.filter(row => row.id !== draft.id), draft];
        if (await save(next)) { setMonth(draft.date.slice(0, 7)); setDraft(null); }
      })(); }}>
        <div className="studio-actions"><label>日期<input aria-label="日志日期" required type="date" value={draft.date} onChange={e => change({ date: e.target.value })} /></label>
          <label>时间<input type="time" required value={draft.time} onChange={e => change({ time: e.target.value })} /></label>
          <label>类型<select value={draft.kind} onChange={e => change({ kind: e.target.value as StudioSiteRelease["kind"] })}>{["更新", "优化", "公告", "下线"].map(kind => <option key={kind}>{kind}</option>)}</select></label></div>
        <label>日志标题<input required value={draft.title} maxLength={180} onChange={e => change({ title: e.target.value })} /></label>
        <label>日志正文<textarea rows={8} value={draft.body.join("\n")} onChange={e => change({ body: e.target.value.split("\n") })} /></label>
        <label className="studio-reference-options"><input type="checkbox" checked={draft.published} onChange={e => change({ published: e.target.checked })} />公开发布</label>
        <div className="studio-actions"><button className="studio-primary" disabled={busy}>保存日志</button><button type="button" disabled={busy} onClick={() => select(null)}>取消编辑</button>
          {rows.some(row => row.id === draft.id) && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除日志“${draft.title}”？`)) void save(rows.filter(row => row.id !== draft.id)).then(ok => { if (ok) setDraft(null); }); }}>删除日志</button>}</div>
      </form> : <p className="studio-empty">在时间轴选择日志编辑，或新建一条日志。</p>}</div>
    </div>
  </section>;
}
