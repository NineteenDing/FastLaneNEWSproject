import { useEffect, useState, useRef } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { CreatorAccount, CreatorExpressions } from "../contracts";
import { SourceAvatar } from "./source-avatar";
import { CollectedContents } from "./collected-contents";
import { CreatorExpressionEvidence } from "./creator-expressions";

const platforms = { xhs: "小红书", douyin: "抖音", kuaishou: "快手", bilibili: "B站", weibo: "微博", tieba: "百度贴吧", zhihu: "知乎" };
export async function loader({ request, params }: LoaderFunctionArgs) {
  const endpoint = `/api/admin/studio/creators/${encodeURIComponent(params.id!)}`;
  const [creator, expressions] = await Promise.all([adminGet<CreatorAccount>(request, endpoint), adminGet<CreatorExpressions>(request, endpoint + "/expressions")]);
  return { creator, expressions };
}
export const meta = () => [{ title: `博主档案 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });
export default function CreatorProfile() {
  const { creator, expressions } = useLoaderData<typeof loader>();
  return <CreatorProfileView creator={creator} expressions={expressions} />;
}
export function CreatorProfileView({ creator, expressions, embedded = false, refreshExpressions }: { creator: CreatorAccount; expressions: CreatorExpressions; embedded?: boolean; refreshExpressions?: () => void }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  const [message, setMessage] = useState("");
  const evidence = useRef<HTMLElement>(null);
  useEffect(() => { setMessage(""); }, [creator.id]);
  const running = ["queued", "running"].includes(expressions.state), name = creator.name ?? creator.locator;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if(document.visibilityState === "visible" && !evidence.current?.closest("[hidden]")) { if (refreshExpressions) refreshExpressions(); else revalidator.revalidate(); } }, 5000); return () => window.clearInterval(timer);
  }, [creator.id, running, revalidator, refreshExpressions]);
  async function learn() {
    const result = await action.run<{ queued: boolean; reason?: string }>("POST", `/api/admin/studio/creators/${creator.id}/expressions`, { retryFailed: true });
    if (result) { setMessage(result.queued ? "已提交表达学习，后台完成后自动显示" : result.reason === "insufficient_samples" ? "至少需要两份完整正文或已转写视频，当前尚不足" : "当前样本已处理，未重复调用模型"); revalidator.revalidate(); refreshExpressions?.(); }
  }
  const amount = (value: number | null) => value === null ? "未提供" : new Intl.NumberFormat("zh-CN").format(value);
  const date = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "尚无记录";
  return <>
    {!embedded && <header className="studio-page-header"><div><h1>博主档案</h1><p className="studio-caption">历史材料、实际指标与表达参考。</p></div><Link to="/admin/studio/creators">返回博主关注</Link></header>}
    <article ref={evidence} className="studio-evidence"><section><a href={creator.homepage} target="_blank" rel="noopener noreferrer" aria-label={`打开${name}主页`}><SourceAvatar name={name} src={creator.avatarUrl} /></a>
      <h2>{name}</h2><p className="studio-caption">{platforms[creator.platform]} · {creator.archived ? "已移除，历史保留" : creator.enabled ? "已关注" : "已暂停"}{creator.subject ? ` · 同一博主：${creator.subject.name}` : ""}</p>
      <p>{creator.description ?? "简介待补齐"}</p><p className="studio-caption">粉丝 {amount(creator.followerCount)} · 平台作品 {amount(creator.workCount)} · 本库收录 {creator.collectedCount} 条</p>
      <p className="studio-caption">最近发布 {date(creator.latestPublishedAt)} · 成功检查 {date(creator.lastCheckedAt)} · 添加 {date(creator.addedAt)}</p>
    </section>
    <section aria-label="博主表达模式"><h2>表达模式</h2>
      <p className="studio-caption">从最近10份完整材料候选中最多学习5份，不截断正文；至少两份才能开始。每天香港时间03:00自动检查，需后台与模型启用。开头、展开、语气和结尾按实际依据提炼；没有音画证据不推断语速、切镜或流量因果。</p>
      {expressions.changedMaterialIds.length > 0 && <p role="status">{expressions.changedMaterialIds.length} 份依据已更正，以下旧结果暂不用于新稿，等待重新学习。</p>}
      {expressions.library ? <CreatorExpressionEvidence library={expressions.library} /> : <p>尚无已完成的表达模式，原作品仍可直接用作写稿参考。</p>}
      <p role="status">{expressions.error ?? (running ? "表达学习等待或正在后台处理" : expressions.state === "superseded" ? "学习期间样本更正，等待新版本" : message)}</p>
      <div className="studio-actions"><button onClick={learn} disabled={action.busy || running || !expressions.modelEnabled || creator.archived || !creator.enabled}>{action.busy ? "正在提交…" : expressions.state === "failed" ? "重试表达学习" : "学习最新表达样本"}</button>
        <button onClick={() => { revalidator.revalidate(); refreshExpressions?.(); }} disabled={revalidator.state !== "idle"}>刷新档案</button></div>
      {!expressions.modelEnabled && <p className="studio-caption">模型尚未启用，可先在设置中配置。</p>}
    </section>
    {!embedded && <section><h2>历史材料与指标</h2><CollectedContents key={creator.id} id={creator.id} /></section>}</article>
  </>;
}
