/** Platform rank is an observed attention signal, never an inferred view counter. */
export interface PlatformAttentionRow { platform: string; board: string; rank: number; observedAt: string; active: boolean }
export function platformAttention(rows: PlatformAttentionRow[], asOf: string) {
  const at = Date.parse(asOf), byPlatform = new Map<string, { value: number; fresh: boolean; board: string; rank:number }>();
  for (const row of rows) {
    const age = (at - Date.parse(row.observedAt)) / 3600000;
    if (!Number.isFinite(age) || age < 0 || !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 100) continue;
    const rankValue = row.rank <= 5 ? 95 - (row.rank - 1) * 2.5 : row.rank <= 10 ? 85 - (row.rank - 5) * 2 : Math.max(40,75 - (row.rank - 10));
    const value = rankValue * 2 ** (-age / 24), fresh = row.active && age <= 2;
    const prior = byPlatform.get(row.platform);
    if (!prior || Number(fresh) > Number(prior.fresh) || fresh === prior.fresh && value > prior.value)
      byPlatform.set(row.platform, { value, fresh, board: row.board,rank:row.rank });
  }
  const channels = [...byPlatform.values()].map(row => ({ board: row.board, value: row.value, freshValue: row.fresh ? row.value : null,rank:row.rank, referenceViews:100000 as const }));
  const fresh = channels.flatMap(row => row.freshValue === null ? [] : [row.freshValue]);
  const platformCount = fresh.length, breakout = platformCount >= 2;
  const bonus = platformCount >= 3 ? 99 : breakout ? 95 : 0;
  return { observed: channels.length ? Math.max(...channels.map(row => row.value), bonus) : null,
    freshObserved: fresh.length ? Math.max(...fresh, bonus) : null, platformCount, breakout, channels };
}

/** Conservative identity match; shared brand words alone never link two different releases. */
export function sameTrendHeadline(a: string, b: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[#＃\s\p{P}\p{S}]/gu, "");
  const releaseModel = (value: string) => {
    if (!/发布|推出|上线|开源|released?|launched?|introduc(?:e|ed|ing)/i.test(value) || /即将|拟|传闻|预告|削弱|网安|漏洞|泄露|争议|rumou?r|controvers|vulnerab|coming soon/i.test(value)) return null;
    const model = value.match(/\b(?:GPT[-‐‑ ]?\d+(?:\.\d+)?(?:[- ](?:Terra|Sol|Astra|Luna|Pro))?|Kimi\s*K?\d+(?:\.\d+)?(?:\s*Pro)?|Gemini\s*\d+(?:\.\d+)?(?:\s*Pro)?|Qwen[-\s]?\d+(?:\.\d+)?(?:[-\w.]+)?)/i)?.[0];
    return model ? normalize(model) : null;
  };
  const modelA=releaseModel(a), modelB=releaseModel(b);
  if(modelA && modelB) return modelA===modelB;
  const clean = (value:string) => value.replace(/^(?:如何评价|如何看待|怎么看待|你如何评价)\s*/,'').replace(/^(?:浙江宣传|人民日报|央视新闻)[：:]\s*/,'');
  const left = normalize(clean(a)), right = normalize(clean(b)), shorter = left.length <= right.length ? left : right, longer = left.length > right.length ? left : right;
  return shorter.length >= 8 && longer.includes(shorter);
}
