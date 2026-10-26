import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { SourceImage, SourceImages } from "../contracts";
import { isManagedImageUrl } from "../image-references";
import { externalUrl } from "./external-url";

const labels = { empty: "原文尚未保存可处理的配图链接", not_requested: "配图尚未提交处理", pending: "配图等待安排", queued: "配图已排队", running: "正在保存配图", ready: "来源配图已保存", failed: "配图尚未全部保存" };

function ImageEvidence({ image }: { image: SourceImage }) {
  const [failed, setFailed] = useState(false), original = externalUrl(image.sourceUrl), article = externalUrl(image.articleUrl);
  if (!isManagedImageUrl(image.url)) return null;
  return <figure>{failed ? <p>图片暂时无法读取。<button onClick={() => setFailed(false)}>重新读取图片</button></p>
    : <a href={image.url} target="_blank" rel="noopener noreferrer"><img src={image.url} alt={image.description || "新闻来源配图"} loading="lazy" onError={() => setFailed(true)} /></a>}
    <figcaption>{image.description || "来源未提供图片说明"}<br />文章版本 {image.revision} · 授权信息未知<br />
      {article && <a href={article} target="_blank" rel="noopener noreferrer">来源文章</a>}{article && original && " · "}{original && <a href={original} target="_blank" rel="noopener noreferrer">图片原链接</a>}
    </figcaption></figure>;
}
export function SourceImagesEvidence({ value, snapshot = false }: { value?: SourceImages; snapshot?: boolean }) {
  return <><h3>来源配图</h3>
    {!value ? <p className="studio-caption">这条记录尚未保存来源配图信息。</p> : <>
      <p className="studio-caption">{snapshot ? "冻结时记录：" : ""}{labels[value.state]}{value.candidateCount > 0 && ` · 已保存 ${value.images.length} / ${value.candidateCount} 张`}。</p>
      {value.images.length > 0 && <><p className="studio-caption">图片来自原新闻，授权未知；点击可查看已保存图片，不代表可自由商用。</p>
        <div className="studio-keyframes" aria-label="已保存的新闻配图">{value.images.map(image => <ImageEvidence key={image.sourceUrl} image={image} />)}</div></>}
      {value.error && <p className="studio-caption">{value.error}</p>}
    </>}
  </>;
}

/** Live controls are explicit; frozen readers render their own stored image list only. */
export function SourceImagesPanel({ materialId, initial }: { materialId: string; initial?: SourceImages }) {
  const [value, setValue] = useState(initial), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [changed, setChanged] = useState(false);
  const pending = useRef<AbortController | null>(null), alive = useRef(true), action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  const key = initial?.versionKey;
  const refresh = useCallback(async () => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true);
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/admin/studio/intelligence/${encodeURIComponent(materialId)}/images`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("reading unavailable");
      const next: SourceImages = await response.json();
      if (!(next.state in labels) || !/^[a-f0-9]{64}$/.test(next.versionKey)) throw new Error("invalid state");
      if (alive.current && !controller.signal.aborted) {
        if (key && next.versionKey !== key) setChanged(true);
        else { setValue(next); setFailed(false); }
      }
    } catch { if (alive.current && pending.current === controller) setFailed(true); }
    finally { clearTimeout(deadline); if (alive.current && pending.current === controller) { pending.current = null; setBusy(false); } }
  }, [materialId, key]);
  useEffect(() => {
    if (changed || !value?.enabled || !["pending", "queued", "running"].includes(value.state)) return;
    const timer = setInterval(() => { if (!document.hidden && !pending.current) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [changed, value?.state, value?.enabled, refresh]);
  async function submit() {
    if (!value) return;
    const result = await action.run("POST", `/api/admin/studio/intelligence/${encodeURIComponent(materialId)}/images`, { versionKey: value.versionKey }, { revalidate: false });
    if (result && alive.current) await refresh();
  }
  return <section aria-label="新闻来源配图">
    <SourceImagesEvidence value={value} />
    {changed ? <><p className="studio-notice">新闻版本已更新，请刷新情报后查看对应配图。</p><button onClick={() => revalidator.revalidate()}>刷新情报</button></>
      : <>{failed && <p role="alert" className="studio-caption">配图状态暂时无法读取，已保存图片仍保留，可重新刷新。</p>}
        {value && !value.enabled && !["ready", "empty"].includes(value.state) && <p className="studio-caption">采集尚未启用，当前不会下载新图片。</p>}
        <div className="studio-actions"><button disabled={busy || action.busy} onClick={() => void refresh()}>{busy ? "正在刷新…" : "刷新配图状态"}</button>
          {value?.enabled && ["not_requested", "pending", "failed"].includes(value.state) && <button disabled={busy || action.busy} onClick={submit}>{action.busy ? "正在提交…" : value.state === "failed" ? "重试保存配图" : "保存来源配图"}</button>}</div></>}
  </section>;
}
