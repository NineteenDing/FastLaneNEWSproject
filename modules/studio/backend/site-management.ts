import { z } from "zod";
import type { ChangelogResponse, SiteAbout } from "@aihot/contracts/site";
import { isValidDate } from "@aihot/contracts/time";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { SiteManagement } from "../site-management-contracts.ts";

const KEY = "studio_site_management";
const aboutSchema = z.object({ title: z.string().trim().min(1).max(120), subtitle: z.string().trim().max(500),
  paragraphs: z.array(z.string().trim().min(1).max(1500)).max(10) }).strict();
const schema = z.object({ version: z.number().int().nonnegative(), about: aboutSchema,
  releases: z.array(z.object({ id: z.uuid(), date: z.string().refine(isValidDate, "日期无效"), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    kind: z.enum(["更新", "优化", "公告", "下线"]), title: z.string().trim().min(1).max(180), body: z.array(z.string().max(1500)).min(1).max(30), published: z.boolean() }).strict()).max(200)
}).strict().refine(value => new Set(value.releases.map(row => row.id)).size === value.releases.length, "日志编号不能重复");
const defaults: SiteManagement = { version: 0, about: { title: "少折腾，多出片。", subtitle: "为AI视频、漫剧与影视创作者整理值得关注的新变化。",
  paragraphs: ["FastLaneNEWS 聚合AI影视新闻摘要，归并同一事件的报道，保留原文出处。"] }, releases: [] };

export async function siteManagement(db: Db = sql): Promise<SiteManagement> {
  const [row] = await db<{ value: SiteManagement }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  return row ? schema.parse(row.value) : structuredClone(defaults);
}

export async function saveSiteManagement(input: unknown, actor: string): Promise<SiteManagement> {
  const next = schema.parse(input);
  return sql.begin(async tx => {
    const db = tx as Db;
    await db`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
    const before = await siteManagement(db);
    if (before.version !== next.version) throw new Conflict("站点资料已被修改，请刷新后重试");
    const saved = { ...next, version: before.version + 1 };
    await db`INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${db.json(saved)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "studio.site.save", `settings:${KEY}`, null, before, saved, { db });
    return saved;
  });
}

export const CONTACT_FILES = { "bilibili.png": ["B站", "查看工作室视频"], "channels.png": ["视频号", "在微信中识别视频号专用码"],
  "douyin.png": ["抖音", "在抖音中识别专用码"], "wecom.png": ["企业微信客服", "联系工作室"] } as const;

export async function publicSiteAbout(): Promise<SiteAbout> {
  const state = await siteManagement();
  return { ...state.about, codes: Object.entries(CONTACT_FILES).map(([file, [label, note]]) => ({ label, note, imageUrl: `/api/site/studio-contact/${file}` })) };
}

export async function publicSiteChangelog(): Promise<ChangelogResponse> {
  const { releases } = await siteManagement();
  const published = releases.filter(row => row.published).sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  return { latestVersion: published[0] ? `${published[0].date}T${published[0].time}` : "",
    releases: published.map(({ date, time, kind, title, body }) => ({ date, time, kind, title, body })) };
}
