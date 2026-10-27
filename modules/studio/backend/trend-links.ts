import { sql, type Db } from "@aihot/backend/db";
import { sameTrendHeadline, type PlatformAttentionRow } from "./platform-attention.ts";
import { trendRepresentative } from "./trend-representative.ts";
import type { SharedMaterial } from "./shared-material.ts";

/** Strong headline identity only; ambiguous candidates wait rather than boosting several events. */
export async function refreshTrendEventLinks() {
 return sql.begin(async db=>{
  await db`SELECT pg_advisory_xact_lock(hashtext('studio.trend-event-links'))`;
  const direct = await db`INSERT INTO studio_trend_event_links(signal_id,signal_context_key,event_id,material_id,source_key,method)
    SELECT n.signal_id,n.relevance_key,m.event_id,m.material_id,m.source_key,'collected_material'
    FROM studio_trend_news n JOIN studio_trend_signals signal ON signal.id=n.signal_id AND signal.relevance_key=n.relevance_key
    JOIN studio_history_index h ON h.article_id=n.article_id
    JOIN studio_shared_event_members m ON m.material_id=h.material_id AND m.source_key=h.knowledge->>'sourceKey'
    WHERE n.state='ready' ON CONFLICT(signal_id,event_id,material_id,source_key) DO UPDATE SET signal_context_key=EXCLUDED.signal_context_key,linked_at=EXCLUDED.linked_at,method=EXCLUDED.method WHERE studio_trend_event_links.signal_context_key IS DISTINCT FROM EXCLUDED.signal_context_key RETURNING signal_id`;
  const signals = await db<{ id: string; title: string; key:string }[]>`SELECT s.id, s.title,s.relevance_key AS key FROM studio_trend_signals s
    JOIN studio_trend_relevance r ON r.signal_id = s.id AND r.context_key = s.relevance_key
    JOIN studio_trend_boards b ON b.platform = s.platform JOIN sources source ON source.id = b.source_id
    WHERE r.state = 'completed' AND r.result->>'decision' = 'relevant' AND source.enabled AND NOT source.archived
      AND s.last_seen_at >= now() - interval '48 hours' ORDER BY s.last_seen_at DESC LIMIT 200`;
  if (!signals.length) return { linked: direct.length };
  const members = await db<{ id:string; shared:SharedMaterial; eventId: string; materialId: string; sourceKey: string; title: string; titleZh: string | null }[]>`
    SELECT m.material_id AS id,m.evidence AS shared,m.event_id AS "eventId", m.material_id AS "materialId", m.source_key AS "sourceKey", h.title,
      coalesce(m.evidence->>'titleZh', p.title) AS "titleZh"
    FROM studio_shared_event_members m JOIN studio_history_index h ON h.material_id = m.material_id AND h.knowledge->>'sourceKey' = m.source_key
    JOIN articles a ON a.id = h.article_id JOIN sources source ON source.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN editorial_overrides o ON o.article_id = a.id
    WHERE source.participation_mode = 'editorial' AND o.visibility IS DISTINCT FROM 'withdrawn'
      AND jsonb_array_length(coalesce(m.evidence->'facts', '[]'::jsonb)) > 0 AND h.published_at >= now() - interval '7 days'
    ORDER BY h.published_at DESC LIMIT 800`;
  let linked = direct.length;
  const existing=await db<{signalId:string;key:string;eventId:string}[]>`SELECT signal_id AS "signalId",signal_context_key AS key,event_id AS "eventId" FROM studio_trend_event_links
    WHERE signal_id=ANY(${signals.map(s=>s.id)}::uuid[])`;
  for (const signal of signals) {
    let matches = members.filter(member => sameTrendHeadline(signal.title, member.title) || !!member.titleZh && sameTrendHeadline(signal.title, member.titleZh));
    if (new Set(matches.map(row => row.eventId)).size !== 1) {
      const representative=trendRepresentative(signal.title,matches.map(row=>({...row,linked:existing.some(link=>link.signalId===signal.id&&link.key===signal.key&&link.eventId===row.eventId)})));
      if(!representative)continue;
      matches=matches.filter(row=>row.eventId===representative.eventId);
    }
    for (const member of matches) linked += (await db`INSERT INTO studio_trend_event_links (signal_id,signal_context_key,event_id,material_id,source_key,method)
      VALUES (${signal.id},${signal.key},${member.eventId},${member.materialId},${member.sourceKey},'exact_headline') ON CONFLICT(signal_id,event_id,material_id,source_key) DO UPDATE SET signal_context_key=EXCLUDED.signal_context_key,linked_at=EXCLUDED.linked_at WHERE studio_trend_event_links.signal_context_key IS DISTINCT FROM EXCLUDED.signal_context_key RETURNING signal_id`).length;
  }
  return { linked };
 });
}

/** Latest successful platform snapshot at cutoff; absence on its newer success means off the board. */
export async function linkedTrendObservations(db: Db, eventIds: string[], asOf: Date) {
  const result = new Map<string, PlatformAttentionRow[]>();
  if (!eventIds.length) return result;
  const rows = await db<Array<PlatformAttentionRow & { eventId: string }>>`WITH candidates AS (SELECT l.signal_id,l.linked_at,l.event_id AS "eventId", s.platform,
    s.platform AS board, observation.rank, observation.observed_at::text AS "observedAt",
    observation.observed_at >= latest.at AS active
    FROM studio_trend_event_links l JOIN studio_trend_signals s ON s.id = l.signal_id AND s.relevance_key=l.signal_context_key
    JOIN studio_trend_relevance relevance ON relevance.signal_id=s.id AND relevance.context_key=s.relevance_key AND relevance.state='completed' AND relevance.result->>'decision'='relevant'
    JOIN studio_trend_boards board ON board.platform = s.platform JOIN sources source ON source.id = board.source_id
    JOIN studio_history_index h ON h.material_id = l.material_id AND h.knowledge->>'sourceKey' = l.source_key
    JOIN articles a ON a.id = h.article_id JOIN sources material_source ON material_source.id = a.source_id
    LEFT JOIN editorial_overrides override ON override.article_id = a.id
    JOIN LATERAL (SELECT o.rank,o.observed_at FROM studio_trend_observations o WHERE o.signal_id=s.id AND o.observed_at <= ${asOf}
      ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) observation ON true
    JOIN LATERAL (SELECT max(o.observed_at) AS at FROM studio_trend_observations o JOIN studio_trend_signals other ON other.id=o.signal_id
      WHERE other.platform=s.platform AND o.observed_at <= ${asOf}) latest ON true
    WHERE l.linked_at <= ${asOf} AND h.collected_at <= ${asOf}
      AND source.enabled AND NOT source.archived AND material_source.participation_mode='editorial' AND override.visibility IS DISTINCT FROM 'withdrawn'),
    representative AS (SELECT DISTINCT ON(signal_id) signal_id,"eventId" FROM candidates ORDER BY signal_id,linked_at,"eventId")
    SELECT c."eventId",c.platform,c.board,c.rank,c."observedAt",c.active FROM candidates c JOIN representative r
      ON r.signal_id=c.signal_id AND r."eventId"=c."eventId" WHERE c."eventId"=ANY(${eventIds}::uuid[])`;
  for (const row of rows) result.set(row.eventId, [...(result.get(row.eventId) ?? []), row]);
  return result;
}
