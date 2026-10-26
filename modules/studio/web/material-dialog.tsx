import { useEffect, useState } from "react";
import type { CreatorWork, IntelligenceDetail, MediaProcessingStatus } from "../contracts";
import { Dialog } from "./dialog";
import { MaterialDetail, MaterialEvidence } from "./material-reading";

/** Shared private reader. Historical callers pass their frozen evidence and never fetch current facts. */
export function MaterialDialog({ id, snapshot, snapshotPath, onClose }: { id: string; snapshot?: IntelligenceDetail; snapshotPath?: string; onClose(): void }) {
  const [data, setData] = useState<{ item: IntelligenceDetail; media: MediaProcessingStatus | null; work: CreatorWork | null } | null>(null);
  const [failed, setFailed] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (snapshot) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setData(null); setFailed("");
    async function read<T>(path: string): Promise<T> { const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal }); if (!response.ok) throw new Error(); return response.json(); }
    void (async () => {
      if (snapshotPath) {
        const response = await fetch(snapshotPath, { cache: "no-store", credentials: "same-origin", signal });
        if (!response.ok) throw new Error(response.status === 409 ? "候选已更新，请关闭并刷新选题后查看。" : "本版材料暂时无法读取，请重试或关闭后刷新。");
        const item = await response.json() as IntelligenceDetail;
        if (!controller.signal.aborted) setData({ item, media: null, work: null });
        return;
      }
      const item = await read<IntelligenceDetail>(`/api/admin/studio/intelligence/${encodeURIComponent(id)}`);
      const [media, work] = await Promise.all([item.kind === "video" && id.startsWith("creator:") ? read<MediaProcessingStatus>(`/api/admin/studio/media-processing/${id.slice(8)}`) : null,
        item.kind !== "news" ? read<{ work: CreatorWork | null }>(`/api/admin/studio/intelligence/${encodeURIComponent(id)}/work`).then(value => value.work) : null]);
      if (!controller.signal.aborted) setData({ item, media, work });
    })().catch(error => { if (!controller.signal.aborted) setFailed(error instanceof Error && error.message ? error.message : "内容暂时无法读取。"); });
    return () => controller.abort();
  }, [id, snapshot, snapshotPath, revision]);
  return <Dialog title="情报详情" onClose={onClose} wide>{snapshot ? <MaterialEvidence item={snapshot} snapshot />
    : failed ? <p role="alert">{failed}<button onClick={() => setRevision(value => value + 1)}>重试</button></p>
    : data ? snapshotPath ? <MaterialEvidence item={data.item} snapshot /> : <MaterialDetail key={id} item={data.item} media={data.media} work={data.work} embedded /> : <p role="status">正在读取内容…</p>}</Dialog>;
}
