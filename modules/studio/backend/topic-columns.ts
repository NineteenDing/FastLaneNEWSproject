import type { TopicColumn, TopicColumns } from "../contracts.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";

export const topicAudience = "关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者";
const v1Audience = "AI视频、漫剧、影视创作者，偏实操与提效";
const v1Requirements = "面向AI视频、漫剧、影视创作者；核心事实有来源，说明具体观看收益、适用条件和限制，能在约两分钟内讲清。";
const v2Requirements = "面向关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的人；核心事实有来源，说明具体观看收益、适用条件和限制。";
// Version 1 stays the immutable historical baseline.
const v1Definitions = [
  ["practice", "实操与提效", "人物一致性、分镜衔接、运镜、口型、配音、批量制作和流程返工", "问题解决、操作演示、流程优化", "有明确问题、可执行步骤、可展示结果，并说明适用条件", "只有效果展示，无方法、参数或可验证路径"],
  ["models", "模型与工具", "视频生成、漫剧制作、图像与音频工具的能力、成本和使用门槛", "场景推荐、工具对比、替代方案", "说清适合谁、解决什么、相比现有方案的变化及限制", "单纯罗列工具、无依据的排名、只有宣传口号"],
  ["news", "新闻与实际影响", "模型更新、功能上线、价格、额度、平台规则和服务调整", "变化解释、实际影响、下一步建议", "来源可信，确实影响创作者的成本、能力、流程或决策", "与AI影视创作关系弱，只有宏观热度"],
  ["cases", "案例与制作方法", "优秀作品、镜头组织、叙事节奏、制作流程与失败经验", "案例拆解、方法复现、经验总结", "能提炼可借鉴方法，已知与推测的制作环节分开", "仅因播放高而推荐，无法解释可借鉴之处"],
  ["other", "其他", "不符合现有栏目但仍与目标观众有关的新问题或交叉方向", "探索、争议辨析、跨方向综合", "有独立价值且不能合理放入已有栏目", "不相关、证据不足或没有独立选题价值的材料仅归档"],
] as const;
const v2Definitions = [
  ["practice", "实操与提效", "怎样完成某项创作或减少返工", "AI制作方法、流程、教程、具体可验证经验", "有明确问题、可执行步骤或路径、可展示结果，并说明适用条件", "只有效果展示、无方法、参数或可验证路径；纯作品展示优先cases"],
  ["models", "模型与工具", "什么能力或产品变化，适合谁", "AI模型发布、能力、成本、限制、工具比较、开放方式", "说清变化、适合谁、实际条件和限制；不要求亲测或教程", "广告口号、无依据的排名、只有宣传材料"],
  ["news", "新闻与实际影响", "发生了什么，为何影响受众", "AI政策、行业事件、事故、授权与演员问题、平台变化、重要通用AI事件", "核心事实有来源，说明实际影响；不要求下一步怎么操作", "低价值泛融资、与受众关系弱、只有宏观热度"],
  ["cases", "作品与案例", "出现了什么作品，人们怎样创作或观看它", "AI短片、漫剧、音乐作品、镜头叙事、观众反应、传播现象、失败与制作案例", "呈现作品、创作或观看事实及出处；不强制提炼制作方法", "只有效果视频、无可用事实或出处者待处理，不直接入选"],
  ["other", "其他", "不符合现有栏目但仍与目标观众有关的新问题或交叉方向", "探索、争议辨析、跨方向综合", "有独立价值且不能合理放入已有栏目", "不相关、证据不足或没有独立选题价值的材料仅归档"],
] as const;

type ColumnDefinition = readonly [string, string, string, string, string, string];
function build(definitions: readonly ColumnDefinition[], version: number, requirements: string): TopicColumn[] {
  return definitions.map(([id, name, questions, videoForms, requirement, exclusions], index) => ({
    id, version, name, questions, videoForms, requirements: `${requirements}\n${requirement}`, exclusions,
    enabled: true, sortOrder: (index + 1) * 10, isFallback: id === "other", maxDirections: id === "other" ? 5 : 3,
  }));
}
const v1Defaults = build(v1Definitions, 1, v1Requirements);
const v2Defaults = build(v2Definitions, 2, v2Requirements);
const builtIn = new Set(v2Defaults.map(column => column.id));

export async function currentColumns(db: Db): Promise<TopicColumn[]> {
  const saved = await db<{ definition: TopicColumn }[]>`SELECT DISTINCT ON (column_id) definition
    FROM studio_topic_column_versions ORDER BY column_id, version DESC`;
  const merged = new Map(v2Defaults.map(column => [column.id, column]));
  for (const row of saved) {
    // Saved v1 semantics of a built-in column are history, not the current column definition.
    if (row.definition.version >= 2 || !builtIn.has(row.definition.id)) merged.set(row.definition.id, row.definition);
  }
  return [...merged.values()].sort((a, b) => Number(a.isFallback) - Number(b.isFallback) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export async function topicColumns(): Promise<TopicColumns> {
  return { audience: topicAudience, rows: await currentColumns(sql) };
}

const columnId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const fields = z.object({ name: z.string().trim().min(1).max(80), questions: z.string().trim().min(1).max(3000),
  videoForms: z.string().trim().min(1).max(2000), requirements: z.string().trim().max(5000).optional(),
  exclusions: z.string().trim().max(3000).optional(), sortOrder: z.number().int().min(0).max(10000).optional(), enabled: z.boolean().optional() });

export async function saveTopicColumn(id: string | null, input: unknown, actor: string) {
  if (id !== null) columnId.parse(id);
  const changes = id === null ? fields.strict().parse(input)
    : fields.partial().extend({ version: z.number().int().positive() }).strict().parse(input);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const rows = await currentColumns(tx), before = id === null ? undefined : rows.find(column => column.id === id);
    if (id !== null && !before) return null;
    if (before && (!("version" in changes) || changes.version !== before.version)) throw new Conflict("栏目已被其他窗口修改，请刷新后重试");
    const column: TopicColumn = { id: id ?? randomUUID(), name: "", questions: "", videoForms: "",
      requirements: v2Requirements, exclusions: "", enabled: true,
      sortOrder: Math.min(10000, Math.max(0, ...rows.filter(row => !row.isFallback).map(row => row.sortOrder)) + 10),
      isFallback: false, maxDirections: 3, ...before, ...changes, version: (before?.version ?? 0) + 1 };
    if (column.isFallback && (column.name !== "其他" || !column.enabled)) throw new Conflict("其他是固定的兜底栏目，不能改名或停用");
    if (rows.some(row => row.id !== column.id && row.name.toLowerCase() === column.name.toLowerCase())) throw new Conflict("已有同名栏目，请使用其他名称");
    if (before) await tx`INSERT INTO studio_topic_column_versions (column_id, version, definition)
      VALUES (${before.id}, ${before.version}, ${tx.json({ ...before })}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO studio_topic_column_versions (column_id, version, definition)
      VALUES (${column.id}, ${column.version}, ${tx.json({ ...column })})`;
    await audit(actor, "studio.topic.column", `column:${column.id}`, null, before ?? null, column, { db: tx });
    return { column };
  });
}

export async function topicColumnVersion(id: string, version: unknown) {
  columnId.parse(id); const number = z.coerce.number().int().positive().parse(version);
  const [saved] = await sql<{ definition: TopicColumn }[]>`SELECT definition FROM studio_topic_column_versions WHERE column_id = ${id} AND version = ${number}`;
  const column = saved?.definition ?? (number === 1 ? v1Defaults.find(column => column.id === id) : number === 2 ? v2Defaults.find(column => column.id === id) : undefined);
  return column ? { audience: number === 1 ? v1Audience : topicAudience, column } : null;
}
