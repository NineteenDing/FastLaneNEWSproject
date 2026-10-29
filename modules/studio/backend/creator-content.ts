import {creatorMediaRelevant} from "./creator-intake.ts";
import { randomUUID } from "node:crypto";
import type { Tx } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import type { MediaCreatorResult } from "./mediacrawler.ts";
import { indexHistoryMaterial } from "./history-index.ts";
import { requestMaterialAnalysis } from "./material-analysis-pending.ts";
import { enqueueMediaProcessing, mediaProcessingEnabled } from "./media-jobs.ts";

/** Shared identity, analysis and media publication for followed and individually imported works. */
export async function saveCreatorContent(tx: Tx, creatorId: string, platform: string, post: MediaCreatorResult["posts"][number]) {

  const observedAt=new Date();
  const [saved] = await tx<{ id: string }[]>`INSERT INTO studio_creator_posts (id, creator_id, external_id, content, content_fingerprint,collected_at,updated_at)
    VALUES (${randomUUID()}, ${creatorId}, ${post.externalId}, ${tx.json(post)}, ${sha256(post.title + '\n' + post.text)},${observedAt},${observedAt})
    ON CONFLICT (creator_id, external_id) DO UPDATE SET content = EXCLUDED.content, content_fingerprint = EXCLUDED.content_fingerprint, updated_at = EXCLUDED.updated_at RETURNING id`;
  await indexHistoryMaterial(tx, "creator:" + saved!.id);
  await requestMaterialAnalysis(tx, "creator:" + saved!.id);
  await tx`INSERT INTO studio_creator_observations (id, post_id, metrics,observed_at) VALUES (${randomUUID()}, ${saved!.id}, ${tx.json(post.metrics)},${observedAt})`;
  if (creatorMediaRelevant(post) && post.kind === "video" && mediaProcessingEnabled() && ["bilibili", "weibo", "xhs", "douyin", "kuaishou"].includes(platform))
    await enqueueMediaProcessing(saved!.id, "system:studio.creator.collect", { db: tx });
  return saved!.id;
}
