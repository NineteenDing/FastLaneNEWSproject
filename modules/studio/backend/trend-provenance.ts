import type { Tx } from "@aihot/backend/db";

/** Indexed relation to the saved discovery observation, not a live re-interpretation of a changed title. */
export function materialTrendsSql(db: Tx, postId: ReturnType<Tx>) {
  return db`SELECT coalesce(jsonb_agg(d.signal_snapshot ORDER BY d.created_at, d.signal_id), '[]'::jsonb) AS trends
    FROM studio_content_imports i JOIN studio_trend_deep_reads d ON d.import_id = i.id WHERE i.post_id = ${postId}`;
}

/** Capture news-linked ranks now; frozen inputs retain this exact platform snapshot. */
export function newsMaterialTrendsSql(db: Tx, articleId: ReturnType<Tx>) {
  return db`SELECT coalesce(jsonb_agg(item),'[]'::jsonb) AS trends FROM (
    SELECT DISTINCT ON (s.id) jsonb_build_object('id',s.id,'platform',s.platform,'title',s.title,'url',s.url,'method','direct_content',
      'active',last_observation.observed_at >= platform_latest.at,
      'observations',jsonb_build_array(jsonb_build_object('observedAt',last_observation.observed_at,'rank',last_observation.rank,
        'rawHeat',last_observation.raw_heat,'metrics',last_observation.metrics))) AS item
    FROM studio_trend_event_links l JOIN studio_trend_signals s ON s.id=l.signal_id
    JOIN studio_history_index h ON h.material_id=l.material_id AND h.knowledge->>'sourceKey'=l.source_key
    JOIN studio_trend_boards b ON b.platform=s.platform JOIN sources source ON source.id=b.source_id
    JOIN LATERAL(SELECT * FROM studio_trend_observations o WHERE o.signal_id=s.id AND o.observed_at<=now()
      ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) last_observation ON true
    JOIN LATERAL(SELECT max(o.observed_at) AS at FROM studio_trend_observations o JOIN studio_trend_signals other ON other.id=o.signal_id
      WHERE other.platform=s.platform AND o.observed_at<=now()) platform_latest ON true
    WHERE h.article_id=${articleId} AND source.enabled AND NOT source.archived ORDER BY s.id
  ) ranked`;
}
