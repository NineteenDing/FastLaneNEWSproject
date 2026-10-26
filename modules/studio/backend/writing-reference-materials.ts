import { z } from "zod";
import type { Tx } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { frozenTopicMaterials } from "./topic-batches.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import type { TopicBatchMaterial } from "../contracts.ts";

/** Shared evidence lookup for preparation and draft creation, including explicit supplements. */
export async function writingReferenceMaterials(db: Tx, batch: { id: string; startsAt: Date; endsAt: Date }, ids: string[]) {
  const materials = await frozenTopicMaterials(db, batch.id, ids);
  const supplementalIds = ids.filter(id => !materials.some(material => material.id === id));
  if (supplementalIds.length) {
    if (supplementalIds.some(id => id.startsWith("creator:") && !z.uuid().safeParse(id.slice(8)).success)) throw new Conflict("补充作品标识无效，请从情报库重新选择");
    const extra = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db,
      { earliestStart: batch.startsAt, startsAt: batch.startsAt, endsAt: batch.endsAt }, supplementalIds, true)}) selected_materials`;
    if (extra.some(row => !row.evidence.body.trim() || !["ok", "collected", "transcribed"].includes(row.evidence.bodyState))) throw new Conflict("补充原稿或视频转写尚未准备完成，请在情报库处理完成后再建立稿件");
    materials.push(...extra.map(row => row.evidence));
  }
  if (materials.length !== ids.length) throw new Conflict("所选参考尚未收录，请先完成材料读取后再选择");
  return { materials, supplementalIds };
}
