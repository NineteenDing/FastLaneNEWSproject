import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { FilterPolicy } from "../contracts.ts";
import { currentColumns } from "./topic-columns.ts";
import { defaultEventPropagationRules } from "./event-propagation.ts";
import { DEFAULT_EDITORIAL_V2 } from "./editorial-v2.ts";

// Immutable baselines. All edits append versions; historical consumers keep their captured definition.
const v1Defaults: FilterPolicy = {
  version: 1,
  public: { weights: { practical: 35, interest: 25, heat: 20, substance: 12, freshness: 8 },
    selectedAbove: 60, minimumPractical: 10, allowBreakout: true },
  internal: { weights: { heat: 25, freshness: 20, impact: 20, practical: 15, evidence: 15, distinctiveness: 5 } },
  propagation: { ...defaultEventPropagationRules },
  heat: { halfLifeHours: 24, reporterBands: [{ at: 1, value: 15 }, { at: 3, value: 40 }, { at: 5, value: 70 }, { at: 10, value: 100 }],
    videoBands: [{ at: 100000, value: 40 }, { at: 500000, value: 70 }, { at: 1000000, value: 100 }] },
  freshness: { bands: [{ hours: 6, value: 100 }, { hours: 12, value: 87.5 }, { hours: 24, value: 75 },
    { hours: 36, value: 62.5 }, { hours: 48, value: 37.5 }], backgroundValue: 12.5, repostValue: 0 },
  columnMapping: { practice: "practice", models: "models", news: "news", cases: "cases", other: null },
};
const v2Defaults: FilterPolicy = {
  ...structuredClone(v1Defaults), version: 2, schemaVersion: 2, editorial: structuredClone(DEFAULT_EDITORIAL_V2),
};

const percentage = z.number().min(0).max(100);
const anchor = z.tuple([z.number().finite().min(0).max(1e12), percentage]);
const anchors = z.array(anchor).min(2).max(12)
  .refine(rows => rows[0]![0] === 0 && rows[0]![1] === 0, "热度锚点首点必须为(0,0)")
  .refine(rows => rows.every((row, index) => !index || row[0] > rows[index - 1]![0] && row[1] >= rows[index - 1]![1]), "热度锚点须横坐标递增、分数不递减")
  .refine(rows => rows.at(-1)![1] < 100, "热度锚点末点必须小于100");
const freshnessAnchors = z.array(anchor).min(2).max(12)
  .refine(rows => rows[0]![0] === 0, "时效锚点首点必须从0小时开始")
  .refine(rows => rows.every((row, index) => !index || row[0] > rows[index - 1]![0] && row[1] <= rows[index - 1]![1]), "时效锚点须小时递增、分数不增");
const weights6 = z.object({ interest: percentage, impact: percentage, substance: percentage, practical: percentage, freshness: percentage, heat: percentage }).strict()
  .refine(value => Math.abs(Object.values(value).reduce((sum, item) => sum + item, 0) - 100) < 1e-6, "公开评分权重合计必须为100");
const weights7 = z.object({ heat: percentage, interest: percentage, impact: percentage, evidence: percentage, distinctiveness: percentage, practical: percentage, freshness: percentage }).strict()
  .refine(value => Math.abs(Object.values(value).reduce((sum, item) => sum + item, 0) - 100) < 1e-6, "内部评分权重合计必须为100");
const editorial = z.object({
  schemaVersion: z.literal(2), policyVersion: z.string().trim().min(1).max(80),
  public: z.object({
    weights: weights6,
    all: z.object({ S: percentage, B: percentage, I: percentage, D: percentage, compensatedB: percentage }).strict(),
    selected: z.object({ S: percentage, B: percentage, I: percentage, D: percentage, compensatedB: percentage }).strict(),
    general: z.object({ S: percentage, M: percentage, I: percentage, D: percentage, compensatedB: percentage }).strict(),
    nonAi: z.object({ M: percentage, I: percentage, D: percentage, S: percentage }).strict(),
    major: z.object({ M: percentage, I: percentage, D: percentage }).strict(),
  }).strict(),
  internal: z.object({ weights: weights7, normal: z.object({ I: percentage, E: percentage, S: percentage, compensatedB: percentage }).strict() }).strict(),
  heat: z.object({ halfLifeHours: z.number().min(1).max(168), decisionPlaceholder: percentage, reporterAnchors: anchors, videoAnchors: anchors }).strict(),
  freshness: z.object({ anchors: freshnessAnchors, validBackfillValue: percentage, unknownDecision: percentage }).strict(),
  windows: z.object({ allHours: z.number().int().min(1).max(720), selectedHours: z.number().int().min(1).max(720),
    hotHours: z.number().int().min(1).max(720), dailyHours: z.number().int().min(1).max(720),
    lateHours: z.number().int().min(1).max(8760), policyHours: z.number().int().min(1).max(8760) }).strict(),
  breakout: z.object({ reports: z.number().int().min(1).max(1000), views: z.number().int().min(1).max(1e12),
    authors: z.number().int().min(1).max(1000), freshHours: z.number().min(1).max(168) }).strict(),
  daily: z.object({ headlineBandMax: percentage, headlineBandRatio: z.number().min(0).max(1),
    volumeRatio: z.number().min(0).max(1), emergencyHeat: percentage }).strict(),
}).strict();
const publicWeights = z.object({ practical: percentage, interest: percentage, heat: percentage, substance: percentage, freshness: percentage }).strict()
  .refine(value => Math.abs(Object.values(value).reduce((sum, item) => sum + item, 0) - 100) < 1e-6, "公开评分权重合计必须为100");
const internalWeights = z.object({ heat: percentage, freshness: percentage, impact: percentage, practical: percentage, evidence: percentage, distinctiveness: percentage }).strict()
  .refine(value => Math.abs(Object.values(value).reduce((sum, item) => sum + item, 0) - 100) < 1e-6, "内部评分权重合计必须为100");
const bands = z.array(z.object({ at: z.number().int().positive().max(1e12), value: percentage }).strict()).min(1).max(12)
  .refine(rows => rows.every((row, index) => !index || row.at > rows[index - 1]!.at && row.value >= rows[index - 1]!.value), "传播档位须按阈值递增、分数不递减");
export const filterPolicySchema = z.object({ version: z.number().int().positive(), schemaVersion: z.literal(2).optional(), editorial: editorial.optional(),
  public: z.object({ weights: publicWeights, selectedAbove: percentage, minimumPractical: percentage, allowBreakout: z.boolean() }).strict(),
  internal: z.object({ weights: internalWeights }).strict(),
  propagation: z.object({ windowHours: z.number().int().min(1).max(168), independentReports: z.number().int().min(1).max(1000),
    observedViews: z.number().int().min(1).max(1e12), independentAuthors: z.number().int().min(1).max(1000), allowMeme: z.boolean() }).strict(),
  heat: z.object({ halfLifeHours: z.number().min(1).max(168), reporterBands: bands, videoBands: bands }).strict(),
  freshness: z.object({ bands: z.array(z.object({ hours: z.number().min(1).max(720), value: percentage }).strict()).min(1).max(12)
    .refine(rows => rows.every((row, index) => !index || row.hours > rows[index - 1]!.hours && row.value <= rows[index - 1]!.value), "时效档位须按小时递增、分数不递增"),
    backgroundValue: percentage, repostValue: percentage }).strict(),
  columnMapping: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), z.enum(["practice", "models", "news", "cases"]).nullable()),
}).strict();

export async function currentFilterPolicy(db: Db = sql): Promise<FilterPolicy> {
  const [row] = await db<{ definition: FilterPolicy }[]>`SELECT definition FROM studio_filter_policy_versions ORDER BY version DESC LIMIT 1`;
  const saved = row?.definition;
  // A legacy v1 row does not describe the active v2 semantics; the built-in v2 baseline does.
  return structuredClone(saved?.schemaVersion === 2 && saved.editorial ? saved : v2Defaults);
}

export async function filterSettings() {
  return sql.begin("isolation level repeatable read read only", async db => ({ policy: await currentFilterPolicy(db), columns: await currentColumns(db) }));
}

export async function saveFilterSettings(input: unknown, actor: string) {
  const value = filterPolicySchema.parse(input);
  if (value.schemaVersion !== 2 || !value.editorial) throw new Conflict("当前筛选规则缺少 editorial-v2 参数，请刷新页面后重试");
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.filter.policy', 0))`;
    const before = await currentFilterPolicy(db);
    if (value.version !== before.version) throw new Conflict("筛选规则已在其他窗口修改，请刷新后重试");
    const columns = await currentColumns(db);
    if (Object.keys(value.columnMapping).some(id => !columns.some(column => column.id === id)))
      throw new Conflict("栏目已变化，请刷新后设置公开归属");
    const policy = { ...value, version: before.version + 1 };
    await db`INSERT INTO studio_filter_policy_versions (version, definition) VALUES (${before.version}, ${db.json(filterPolicySchema.parse(before))}) ON CONFLICT DO NOTHING`;
    await db`INSERT INTO studio_filter_policy_versions (version, definition) VALUES (${policy.version}, ${db.json(policy)})`;
    await audit(actor, "studio.filter.policy.save", "studio.filter.policy", null, before, policy, { db });
    return { policy };
  });
}

export async function filterPolicyVersion(input: unknown) {
  const version = z.coerce.number().int().positive().parse(input);
  const [row] = await sql<{ definition: FilterPolicy }[]>`SELECT definition FROM studio_filter_policy_versions WHERE version = ${version}`;
  const policy = row?.definition ?? (version === 1 ? structuredClone(v1Defaults) : version === 2 ? structuredClone(v2Defaults) : null);
  return policy ? { policy } : null;
}
