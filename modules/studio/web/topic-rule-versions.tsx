import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicBatch, TopicColumns } from "../contracts";

type Versions = { rootBatchId: string; rows: Array<{id: string; revision: number}> };
export function TopicRuleVersions({ batch }: { batch: TopicBatch }) {
  const navigate = useNavigate(), action = useAdminAction("studio-layout"), active = useRef<AbortController | null>(null);
  const [value, setValue] = useState<{ columns: TopicColumns; versions: Versions } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const changed = value?.columns.rows.filter(column => batch.columns.find(old => old.id === column.id)?.version !== column.version) ?? [];
  async function load() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setLoading(true); setError(""); const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const [columnResponse, versionResponse] = await Promise.all(["/api/admin/studio/columns", `/api/admin/studio/topic-batches/${batch.id}/versions`].map(url =>
        fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })));
      if (!columnResponse.ok || !versionResponse.ok) throw new Error("unavailable");
      const [columns, versions] = await Promise.all([columnResponse.json() as Promise<TopicColumns>, versionResponse.json() as Promise<Versions>]);
      if (active.current === controller) setValue({ columns, versions });
    } catch { if (active.current === controller) setError("版本与最新规则未能读取，请刷新重试；原选题仍保留。"); }
    finally { clearTimeout(deadline); if (active.current === controller) { setLoading(false); active.current = null; } }
  }
  async function revise() {
    if (!value) return;
    setError("");
    const result = await action.run<{ batchId: string }>("POST", `/api/admin/studio/topic-batches/${batch.id}/versions`,
      { columns: value.columns.rows.map(({ id, version }) => ({ id, version })) }, { revalidate: false });
    if (result) navigate(`/admin/studio/topics/batches/${result.batchId}`);
    else setError("重选尚未完成，请核对提示后刷新规则预览再试。已有版本不会被覆盖。");
  }
  const busy = loading || action.busy;
  return <details className="studio-batch-rules" onToggle={event => { if (event.currentTarget.open && !value && !busy) void load(); }}>
    <summary>选题版本与最新规则 · 当前版本 {batch.revision ?? 1}</summary>
    <p className="studio-caption">规则修改默认用于以后批次。这里可按最新规则新建版本，重新初筛、综合与最多两轮审核，可能产生模型费用；原材料、旧选题和已建稿件保持不变。需要后台任务与模型已启用。</p>
    <div className="studio-actions"><button type="button" disabled={busy} onClick={() => void load()}>{loading ? "正在读取…" : "刷新规则与版本"}</button></div>
    {error && <p className="studio-notice" role="alert">{error}</p>}
    {value && <>
      <nav className="studio-actions" aria-label="本批次选题版本">{value.versions.rows.map(row => <Link key={row.id} to={`/admin/studio/topics/batches/${row.id}`} aria-current={row.id === batch.id ? "page" : undefined}>版本 {row.revision}{row.id === batch.id ? "（当前）" : ""}</Link>)}</nav>
      {value.versions.rows.length === 100 && <p className="studio-caption">此处显示最近100个版本，更早版本仍可从历史批次查看。</p>}
      {changed.length ? <><p>最新规则中有 {changed.length} 个栏目变更：</p><ul>{changed.map(column => <li key={column.id}>{column.name} · 版本 {column.version} · {column.enabled ? "已启用" : "已停用"}</li>)}</ul>
        <button type="button" className="studio-primary" disabled={busy} onClick={() => void revise()}>{action.busy ? "正在建立新版本…" : "按最新规则新建选题版本"}</button></>
        : <p className="studio-caption">当前版本已使用最新栏目规则，无需重复选题。</p>}
    </>}
  </details>;
}
