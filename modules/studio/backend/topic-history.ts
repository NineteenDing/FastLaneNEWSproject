import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { historyCandidates, historyIndexPolicy, historyTerms } from "./history-index.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { historySettings } from "./history-settings.ts";
import type { TopicBatchMaterial, TopicHistorySnapshot, TopicMaterialAnalysis } from "../contracts.ts";

/** New submissions opt in atomically. Old in-flight paid work keeps its original input. */
export async function initializeTopicHistory(db: Db, batchId: string) {
  const settings = await historySettings(db);
  await db`INSERT INTO studio_topic_history (batch_id, candidate_limit, evidence_limit) VALUES (${batchId}, ${settings.candidateLimit}, ${settings.evidenceLimit})
    ON CONFLICT (batch_id) DO NOTHING`;
}

export async function frozenTopicHistory(db: Db, batchId: string): Promise<TopicHistorySnapshot | null> {
  const [saved] = await db<{ snapshot: TopicHistorySnapshot | null }[]>`SELECT snapshot FROM studio_topic_history WHERE batch_id = ${batchId}`;
  return saved?.snapshot ?? null;
}

export async function historySourceChanges(db: Db, policy: string, references: Array<{ id: string; fingerprint: string }>) {
  const current = references.length ? await db<{ material_id: string; fingerprint: string }[]>`SELECT material_id, fingerprint FROM studio_history_index
    WHERE material_id = ANY(${references.map(item => item.id)}::text[])` : [];
  return { policyChanged: policy !== historyIndexPolicy,
    changedMaterialIds: references.filter(item => !current.some(row => row.material_id === item.id && row.fingerprint === item.fingerprint)).map(item => item.id) };
}

function anchors(material: TopicBatchMaterial): TopicHistorySnapshot["items"][number]["anchors"] {
  if (material.transcript?.segments.length) return material.transcript.segments.slice(0, 3).map(segment => ({ kind: "video",
    startSeconds: segment.start, endSeconds: segment.end, quote: segment.text }));
  return Array.from(material.body.matchAll(/[^\r\n]+/gu)).slice(0, 3).map((match, index) => {
    const quote = match[0].slice(0, 600);
    return { kind: "text", paragraph: index + 1, start: match.index, end: match.index + quote.length, unit: "utf16", quote };
  });
}

/** Locate adopted quotations in the immutable body, rather than copying opening samples. */
export function historyQuoteAnchors(material: TopicBatchMaterial, quotes: string[]): TopicHistorySnapshot["items"][number]["anchors"] {
  return [...new Set(quotes)].flatMap((quote): TopicHistorySnapshot["items"][number]["anchors"] => {
    const start = material.body.indexOf(quote); if (!quote || start < 0) return [];
    const end = start + quote.length, transcript = material.transcript;
    if (transcript && material.body.endsWith(transcript.text) && transcript.segments.map(segment => segment.text).join("\n") === transcript.text) {
      const transcriptStart = material.body.length - transcript.text.length;
      if (start >= transcriptStart) {
        let offset = transcriptStart;
        const matched = transcript.segments.filter(segment => {
          const segmentStart = offset; offset += segment.text.length + 1;
          return segmentStart < end && segmentStart + segment.text.length > start;
        });
        if (matched.length) return [{ kind: "video" as const, startSeconds: matched[0]!.start, endSeconds: matched.at(-1)!.end, quote }];
      }
    }
    const paragraph = Array.from(material.body.matchAll(/[^\r\n]+/gu)).filter(match => match.index <= start).length;
    return [{ kind: "text" as const, paragraph, start, end, unit: "utf16" as const, quote }];
  });
}

/** One bounded preparation, then immutable inputs for generation/retries/review. Never called by GET. */
export async function prepareTopicHistory(batchId: string, materials: Array<{ material: TopicBatchMaterial; analysis: TopicMaterialAnalysis | null }>) {
  return sql.begin("isolation level repeatable read", async db => {
    await db`SET LOCAL plan_cache_mode = force_custom_plan`;
    const [saved] = await db<{ snapshot: TopicHistorySnapshot | null; candidate_limit: number; evidence_limit: number }[]>`
      SELECT snapshot, candidate_limit, evidence_limit FROM studio_topic_history WHERE batch_id = ${batchId} FOR UPDATE`;
    if (!saved || saved.snapshot) return saved?.snapshot;
    const [batch] = await db<{ starts_at: Date }[]>`SELECT starts_at FROM studio_topic_batches WHERE id = ${batchId}`;
    if (!batch) return undefined;
    const allWords = historyTerms(materials.map(row => [row.material.title, row.analysis?.event ?? "",
      ...(row.analysis?.entities?.flatMap(entity => [entity.name, ...entity.aliases]) ?? [])].join("\n")).join("\n"))
      .filter(word => Array.from(word).length > 1 && !/^\d+$/.test(word));
    const candidates = allWords.length ? await historyCandidates(db, { words: allWords.slice(0, 512), before: batch.starts_at.toISOString(), limit: saved.candidate_limit,
      exclude: materials.map(row => row.material.id) }) : [];
    const selected = candidates.slice(0, saved.evidence_limit);
    const evidence = selected.length ? await db<{ id: string; evidence: TopicBatchMaterial }[]>`SELECT id, evidence FROM (${intelligenceEvidence(db,
      { earliestStart: new Date("0001-01-01T00:00:00Z"), startsAt: batch.starts_at, endsAt: batch.starts_at }, selected.map(item => item.id))}) selected` : [];
    const [complete] = await db`SELECT id FROM studio_history_rebuild WHERE scope = 'all' AND policy = ${historyIndexPolicy} AND state = 'completed'`;
    const snapshot: TopicHistorySnapshot = { policy: historyIndexPolicy, frozenAt: new Date().toISOString(), candidateCount: candidates.length,
      candidateLimit: saved.candidate_limit, evidenceLimit: saved.evidence_limit, omittedQueryTerms: Math.max(0, allWords.length - 512),
      coverage: complete ? "backfilled" : "incremental_only", items: selected.flatMap(candidate => {
        const material = evidence.find(item => item.id === candidate.id)?.evidence;
        return material ? [{ material, fingerprint: candidate.fingerprint, reason: candidate.reason, anchors: anchors(material) }] : [];
      }) };
    const [persisted] = await db<{ snapshot: TopicHistorySnapshot }[]>`UPDATE studio_topic_history SET snapshot = ${db.json(snapshot as never)}
      WHERE batch_id = ${batchId} RETURNING snapshot`;
    if (!persisted) throw new Error("历史背景未能可靠保存，未开始生成请求");
    return persisted.snapshot;
  });
}

export async function topicHistory(batchId: string) {
  z.uuid().parse(batchId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [batch] = await db`SELECT id FROM studio_topic_batches WHERE id = ${batchId}`; if (!batch) return null;
    const [saved] = await db<{ snapshot: TopicHistorySnapshot | null }[]>`SELECT snapshot FROM studio_topic_history WHERE batch_id = ${batchId}`;
    if (!saved?.snapshot) return { state: "not_prepared" as const, items: [], changedMaterialIds: [] };
    const snapshot = saved.snapshot;
    return { ...snapshot, state: "ready" as const,
      ...await historySourceChanges(db, snapshot.policy, snapshot.items.map(item => ({ id: item.material.id, fingerprint: item.fingerprint }))) };
  });
}
