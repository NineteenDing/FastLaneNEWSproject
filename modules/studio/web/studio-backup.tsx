import { useEffect, useRef, useState } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { StudioBackupStatus } from "../contracts";

const names = { not_started: "尚未备份", queued: "等待后台处理", running: "正在备份", completed: "上次任务已完成", failed: "上次任务未完成" };
export function StudioBackupSettings({ active: visible = true }: { active?: boolean }) {
  const action = useAdminAction("studio-layout"), [status, setStatus] = useState<StudioBackupStatus | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [destination, setDestination] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (visible) void refresh(); }, [visible]);
  async function refresh() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/studio/backup", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error("unavailable"); const value = await response.json() as StudioBackupStatus;
      if (!controller.signal.aborted) setStatus(value);
    } catch { if (!controller.signal.aborted) setError("备份状态暂时无法读取，原记录保留，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!status || !["queued", "running"].includes(status.state)) return;
    const timer = setTimeout(() => void refresh(), 5000); return () => clearTimeout(timer);
  }, [status]);
  async function start() {
    if (!window.confirm("把数据库、已保存图片和运行预算设置写入配置的备份目录？备份期间新图片写入会等待；已有内容仍可阅读。")) return;
    const result = await action.run("POST", "/api/admin/studio/backup", {}, { success: "完整备份已提交，完成后此处显示结果", revalidate: false });
    if (result) await refresh();
  }
  async function copyProgram() {
    if (!window.confirm("将程序、配置（含密钥）、数据库和图片/稿件素材复制到指定目录？不包含模型及可重新安装的依赖与缓存。目标位置是服务器路径，请保管好副本。")) return;
    const result = await action.run("POST", "/api/admin/studio/backup", { scope: "portable", destination }, { success: "整体副本已提交，等待后台完成", revalidate: false });
    if (result) await refresh();
  }
  const busy = loading || action.busy, working = status?.state === "queued" || status?.state === "running";
  return <section className="studio-session-settings studio-backup-settings" aria-labelledby="studio-backup-title">
    <h2 id="studio-backup-title">数据备份</h2>
    <section className="studio-settings-panel" aria-label="整体打包复制"><h3>整体打包复制</h3>
      <p className="studio-caption">程序、配置、数据库和稿件图片保存到一个新目录，附文件校验清单。模型、临时视频和缓存不复制；恢复时按锁文件安装依赖。这是副本，不会迁移或停止当前服务。</p>
      <label>复制到服务器上的目录<input aria-label="整体副本目标目录" value={destination} onChange={e => setDestination(e.target.value)} placeholder="例如 D:\\FastLaneBackups（须先创建目录）" maxLength={2000} /></label>
      <div className="studio-actions"><button type="button" disabled={busy || working || !destination.trim()} onClick={() => void copyProgram()}>整体打包复制</button></div>
      <p className="studio-caption">实际写入目标盘前检查空间，保留4.7GB；同盘副本不算机外备份。此目录包含配置密钥，请只放在自己管理的位置。</p>
    </section>
    <p className="studio-caption">配对保存数据库、受保护图片、预算账本与采集设置。模型权重、缓存和临时视频不复制；原运行密钥需要另行安全保管。</p>
    <div className="studio-settings-panel" aria-label="备份状态与操作"><h3>备份状态与操作</h3>
      {status && <><p role="status">{!status.configured ? "未保护 · 尚未配置备份位置" : status.protected ? "近50小时有已完成的机外备份记录" : "尚无近期完整机外备份"} · {names[status.state]}</p>
        {!status.configured && <p className="studio-notice">请先由操作员准备可写的专用目录，在运行配置填写 STUDIO_BACKUP_DIRECTORY，再重启服务。建议使用另一台设备的共享目录。</p>}
        {status.configured && !status.externalDeclared && <p className="studio-caption">当前位置未声明为机外存储，只能手动创建副本，同盘副本不算独立保护。确认机外位置后设置 STUDIO_BACKUP_EXTERNAL=true，后台每天香港时间04:10备份。</p>}
        {status.last && <p className="studio-caption">最后完整记录：{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "short", timeStyle: "short" }).format(new Date(status.last.at))} · {status.last.files} 个文件 · {(status.last.bytes / 1024 ** 2).toFixed(1)} MiB。机外位置为操作员声明，仍需人工核验存储与恢复。</p>}
        {status.error && <p className="studio-notice">{status.error}</p>}</>}
      {error && <p className="studio-notice" role="alert">{error}</p>}
      <div className="studio-actions"><button type="button" className="studio-primary" disabled={busy || !status?.configured || working} onClick={() => void start()}>{action.busy ? "正在提交…" : working ? "备份任务处理中…" : "开始完整备份"}</button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{loading ? "正在读取…" : "刷新备份状态"}</button></div>
      <p className="studio-caption">读取状态不会创建备份。执行需要后台任务已启动；同盘副本目录合计最多512MiB，目标盘仍保留4.7GB底线。失败的目录与旧备份不会自动删除，目录清理由操作员确认。</p>
    </div>
  </section>;
}
