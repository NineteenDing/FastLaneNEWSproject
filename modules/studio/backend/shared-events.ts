import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { historyEvidenceKey } from "./history-entities.ts";
import { historyTerms } from "./history-index.ts";
import type { EventHeat, EventObservation, EventTime, FilterPolicy, TopicBatchMaterial } from "../contracts.ts";
import type { SharedMaterial } from "./shared-material.ts";
import { eventHeat, eventHeatV2, observeEvent, resolveEventTime, type PropagationRow } from "./event-propagation.ts";
import { currentFilterPolicy } from "./filter-settings.ts";
import { DEFAULT_EDITORIAL_V2, type HeatSnapshotV2 } from "./editorial-v2.ts";

/** Freeze the bounded recall once, before paying. Recovery uses exactly the same provider request. */
export async function sharedAnalysisUser(key: string, user: string, material: TopicBatchMaterial) {
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${'studio.shared-context:' + key}, 0))`;
    const [saved] = await db<{ input: { eventCandidates: Array<{ id: string }> } }[]>`SELECT input FROM studio_shared_analysis_contexts WHERE key = ${key}`;
    if (saved) return { user: stableJson(saved.input), candidateIds: saved.input.eventCandidates.map(event => event.id) };
    const words = historyTerms(material.title + " " + material.body.slice(0, 12000));
    const eventCandidates = words.length ? await db<{ id: string; label: string; evidence: SharedMaterial }[]>`
      SELECT id, label, evidence FROM studio_shared_events WHERE terms && ${words}::text[]
        AND created_at >= ${new Date(Date.now() - 30 * 86400_000)}
      ORDER BY cardinality(ARRAY(SELECT term FROM unnest(terms) term WHERE term = ANY(${words}::text[]))) DESC, created_at DESC, id LIMIT 12` : [];
    const input = { ...JSON.parse(user), eventCandidates };
    await db`INSERT INTO studio_shared_analysis_contexts (key, input) VALUES (${key}, ${db.json(input)})`;
    return { user: stableJson(input), candidateIds: eventCandidates.map(event => event.id) };
  });
}

/** Each material version has its own membership; a later correction cannot mutate frozen results. */
export async function persistSharedEvent(db: Db, material: TopicBatchMaterial, shared: SharedMaterial | undefined, analysisKey: string, hasEvidence: boolean) {
  if (!hasEvidence || !["ok", "collected", "transcribed"].includes(material.bodyState) || !material.body.trim()
    || !shared?.event || shared.event.relation === "composite") return null;
  const identityKey = sha256(shared.event.identity.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
    + (shared.event.relation === "development" ? ":development:" + shared.event.candidateId : ""));
  const same = shared.event.relation === "same" ? shared.event.candidateId : null;
  const parent = shared.event.relation === "development" ? shared.event.candidateId : null;
  const [known] = same ? await db<{ id: string }[]>`SELECT id FROM studio_shared_events WHERE id = ${same}` : [];
  if (same && !known) throw new Error("原事件已不可用，未将新报道错误归并");
  let id = known?.id;
  if (!id) {
    const [created] = await db<{ id: string }[]>`INSERT INTO studio_shared_events (id, identity_key, label, terms, evidence, parent_id)
      VALUES (${randomUUID()}, ${identityKey}, ${shared.event.label}, ${historyTerms(shared.event.label + " " + shared.event.identity)}, ${db.json(shared)}, ${parent})
      ON CONFLICT (identity_key) DO NOTHING RETURNING id`;
    id = created?.id ?? (await db<{ id: string }[]>`SELECT id FROM studio_shared_events WHERE identity_key = ${identityKey}`)[0]!.id;
  }
  await db`INSERT INTO studio_shared_event_members (material_id, source_key, event_id, analysis_key, evidence)
    VALUES (${material.id}, ${historyEvidenceKey(material)}, ${id}, ${analysisKey}, ${db.json(shared)})
    ON CONFLICT (material_id, source_key) DO UPDATE SET event_id = EXCLUDED.event_id, analysis_key = EXCLUDED.analysis_key, evidence = EXCLUDED.evidence`;
  return id;
}

export type ObservedSharedEvent = EventObservation & { event: { id: string; label: string; time: EventTime | null }; heat: EventHeat; heatV2: HeatSnapshotV2 };

/** Batched metadata only. Numeric previews and later public processing share one observation implementation. */
export async function sharedEventObservations(db: Db, eventIds: string[], asOf: Date, policy: FilterPolicy): Promise<Map<string, ObservedSharedEvent>> {
  const result = new Map<string, ObservedSharedEvent>();
  if (!eventIds.length) return result;
  const events = await db<{ id: string; label: string; evidence: SharedMaterial }[]>`SELECT id, label, evidence FROM studio_shared_events WHERE id = ANY(${eventIds}::uuid[])`;
  const times = await db<Array<{ eventId: string; reportingKind: string; time: EventTime | null }>>`SELECT m.event_id AS "eventId",
    m.evidence->>'reportingKind' AS "reportingKind", m.evidence->'event'->'time' AS time
    FROM studio_shared_event_members m JOIN studio_history_index h ON h.material_id = m.material_id AND m.source_key = h.knowledge->>'sourceKey'
    WHERE m.event_id = ANY(${eventIds}::uuid[]) AND m.evidence->'event'->'time' IS NOT NULL`;
  const startsAt = new Date(asOf.getTime() - policy.propagation.windowHours * 3600_000);
  const rows = await db<Array<PropagationRow & { eventId: string; published: Date }>>`
      SELECT m.event_id AS "eventId", h.published_at AS published, h.material_id AS "materialId", coalesce('entity:' || s.owner_entity_id, 'group:' || s.signal_group_id,
        'creator-subject:' || member.subject_id::text, 'source:' || s.id, 'creator:' || c.id::text) AS participant,
        m.evidence->>'reportingKind' AS "reportingKind", m.evidence->>'scope' AS scope,
        coalesce(c.platform, 'news') AS platform, coalesce(p.content->>'kind', 'news') AS kind,
        jsonb_array_length(coalesce(m.evidence->'memeEvidence', '[]'::jsonb)) > 0 AS "hasMemeEvidence",
        coalesce(work.work_id::text, p.id::text, h.material_id) AS work,
        CASE WHEN jsonb_typeof(observation.metrics->'views') = 'number' THEN (observation.metrics->>'views')::float8 END AS views,
        coalesce(observation.observed_at, h.collected_at)::text AS "observedAt"
      FROM studio_shared_event_members m JOIN studio_history_index h ON h.material_id = m.material_id AND m.source_key = h.knowledge->>'sourceKey'
      LEFT JOIN articles a ON a.id = h.article_id LEFT JOIN sources s ON s.id = a.source_id
      LEFT JOIN studio_creator_posts p ON p.id = h.post_id LEFT JOIN studio_creator_accounts c ON c.id = p.creator_id
      LEFT JOIN studio_creator_subject_accounts member ON member.account_id = c.id
      LEFT JOIN studio_creator_work_posts work ON work.post_id = p.id
      LEFT JOIN LATERAL (SELECT o.metrics, o.observed_at FROM studio_creator_observations o WHERE o.post_id = p.id AND o.observed_at <= ${asOf}
        ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) observation ON true
      WHERE m.event_id = ANY(${eventIds}::uuid[]) AND h.published_at >= ${startsAt} AND h.published_at <= ${asOf}`;
  const editorial = policy.editorial ?? DEFAULT_EDITORIAL_V2;
  for (const event of events) {
    const members = rows.filter(row => row.eventId === event.id).map(row => ({ ...row,
      publishedAt: row.published.toISOString(), observedAt: row.observedAt ?? null }));
    const qualified = ["direct", "important_ai"].includes(event.evidence.scope) && event.evidence.facts.length > 0;
    const heatV2 = { ...eventHeatV2(members, asOf.toISOString(), editorial), canonicalEventId: event.id };
    result.set(event.id, { event: { id: event.id, label: event.label, time: resolveEventTime(times.filter(row => row.eventId === event.id)) },
      ...observeEvent(members, qualified, asOf.toISOString(), policy.propagation), heat: eventHeat(members, asOf.toISOString(), policy.heat), heatV2 });
  }
  return result;
}

/** Private current observation. Opening a page never groups facts or starts a model request. */
export async function materialEvent(materialId: string) {
  z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/).parse(materialId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [material] = await db<{ eventId: string | null }[]>`SELECT m.event_id AS "eventId" FROM studio_history_index h
      LEFT JOIN studio_shared_event_members m ON m.material_id = h.material_id AND m.source_key = h.knowledge->>'sourceKey' WHERE h.material_id = ${materialId}`;
    if (!material) return null;
    if (!material.eventId) return { state: "unavailable", event: null, propagation: null, breakout: null };
    const policy = await currentFilterPolicy(db), asOf = new Date();
    return { state: "observed", policyVersion: policy.version, ...(await sharedEventObservations(db, [material.eventId], asOf, policy)).get(material.eventId)! };
  });
}
