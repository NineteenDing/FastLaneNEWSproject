/** Platform rank is an observed attention signal, never an inferred view counter. */
export interface PlatformAttentionRow { platform: string; board: string; rank: number; observedAt: string; active: boolean }
export function platformAttention(rows: PlatformAttentionRow[], asOf: string) {
  const at = Date.parse(asOf), byPlatform = new Map<string, { value: number; fresh: boolean; board: string }>();
  for (const row of rows) {
    const age = (at - Date.parse(row.observedAt)) / 3600000;
    if (!row.active || !Number.isFinite(age) || age < 0 || !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 20) continue;
    const rankValue = row.rank <= 5 ? 95 - (row.rank - 1) * 2.5 : row.rank <= 10 ? 85 - (row.rank - 5) * 2 : 75 - (row.rank - 10);
    const value = rankValue * 2 ** (-age / 24), fresh = age <= 2;
    const prior = byPlatform.get(row.platform);
    if (!prior || Number(fresh) > Number(prior.fresh) || fresh === prior.fresh && value > prior.value)
      byPlatform.set(row.platform, { value, fresh, board: row.board });
  }
  const channels = [...byPlatform.values()].map(row => ({ board: row.board, value: row.value, freshValue: row.fresh ? row.value : null }));
  const fresh = channels.flatMap(row => row.freshValue === null ? [] : [row.freshValue]);
  const platformCount = fresh.length, breakout = platformCount >= 2;
  const bonus = platformCount >= 3 ? 99 : breakout ? 95 : 0;
  return { observed: channels.length ? Math.max(...channels.map(row => row.value), bonus) : null,
    freshObserved: fresh.length ? Math.max(...fresh, bonus) : null, platformCount, breakout, channels };
}

/** Conservative identity match; shared brand words alone never link two different releases. */
export function sameTrendHeadline(a: string, b: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[#＃\s\p{P}\p{S}]/gu, "");
  const left = normalize(a), right = normalize(b), shorter = left.length <= right.length ? left : right, longer = left.length > right.length ? left : right;
  return shorter.length >= 8 && longer.includes(shorter);
}
