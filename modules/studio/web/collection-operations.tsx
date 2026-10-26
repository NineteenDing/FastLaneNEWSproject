import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { CollectionOperations } from "../contracts";
import { RuntimeComponentCheck } from "./runtime-components";

export function CollectionTaskControl({ operations }: { operations: CollectionOperations }) {
  const action = useAdminAction("studio-layout"), refresh = useRevalidator();
  async function change() {
    const enabled = !operations.enabled;
    if (enabled && !window.confirm("恢复后，新闻、关注博主、热榜和已排队的图片、视频任务会继续访问对应来源。继续恢复采集？")) return;
    await action.run("PUT", "/api/admin/studio/collection-operations", { version: operations.version, enabled },
      { success: enabled ? "采集已恢复，后台接着处理待办" : "新采集已暂停，待办与已有内容保留" });
  }
  const status = operations.state === "unavailable" ? "设置无法读取，已安全暂停" : operations.enabled ? "已启用" : operations.runtimeAllowed ? "已暂停" : "启动配置未允许";
  return <section className="studio-session-settings studio-collection-control" aria-labelledby="collection-operations-title">
    <h2 id="collection-operations-title">采集任务</h2>
    <div className="studio-actions"><span className="studio-caption" role="status">全局采集：{status}</span>
      <button type="button" onClick={change} disabled={action.busy || !operations.runtimeAllowed || operations.state !== "ready"}>
        {action.busy ? "正在更新…" : operations.enabled ? "暂停新采集" : "恢复采集"}</button>
      <button type="button" onClick={() => refresh.revalidate()} disabled={action.busy || refresh.state !== "idle"}>刷新采集状态</button>
    </div>
    <p className="studio-caption">暂停后不领取新任务，已开始的请求可能完成；视频的持久化和安全清理继续执行。来源各自的关注、启停和历史内容保留，模型任务由下方单独控制。</p>
    {!operations.runtimeAllowed && <p className="studio-notice">启动配置尚未允许采集。请在本项目配置中设置 COLLECT_ENABLED=true，并启用后台任务、重启服务；仅保存平台登录信息不会开始采集。</p>}
    {operations.state === "unavailable" && <p className="studio-notice">请检查运行数据目录的采集设置后刷新。当前不会覆盖无法读取的配置。</p>}
    <p className="studio-caption">恢复需要后台任务正在运行；已排队项目沿原队列继续，不代表所有平台已经连接成功。</p>
    <RuntimeComponentCheck />
  </section>;
}
