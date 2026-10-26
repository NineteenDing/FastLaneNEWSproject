import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { Conflict, audit } from "@aihot/backend/audit";
import { sha256 } from "@aihot/backend/lib/ids";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { currentColumns, topicAudience } from "./topic-columns.ts";
import { currentWindow } from "./topic-batches.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { saveCreatorContent } from "./creator-content.ts";
import { indexHistoryMaterial, historyIndexPolicy } from "./history-index.ts";
import { scoreTopicDraft } from "./topic-directions.ts";
import { enabledWritingSkills } from "./writing-skills.ts";
import { attachWritingSourceImages, protectWritingImages } from "./writing-images.ts";
import { recordLanguageSample } from "./language-samples.ts";
import { createImageAssets } from "./image-assets.ts";
import type { CreatorPlatform, TopicBatchMaterial, TopicRecommendationResult, TopicReview, WritingProject } from "../contracts.ts";

const key = "studio.acceptance.examples.v1";
const cleanupKey = "studio.acceptance.examples.assets-pending";
type Manifest = { version: 1; createdAt: string; sources: string[]; creators: string[]; posts: string[]; articles: string[]; batches: string[]; projects: string[]; previews: string[]; assets: string[]; learning: string[]; columns: string[] };
const read = async (db: typeof sql | Tx = sql) => (await db<{ value: Manifest }[]>`SELECT value FROM settings WHERE key = ${key}`)[0]?.value;
const status = (m?: Manifest) => ({ active: !!m, createdAt: m?.createdAt ?? null, counts: m ? { sources: m.sources.length, creators: m.creators.length, materials: m.posts.length + m.articles.length, batches: m.batches.length, projects: m.projects.length } : null });
export async function acceptanceExamples() { return { ...status(await read()), pendingImageCleanup: !!(await sql`SELECT key FROM settings WHERE key = ${cleanupKey}`).length }; }
function permitted() {
  const url = new URL(config.databaseUrl), name = decodeURIComponent(url.pathname.slice(1));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !(name === "studio_local" || /(?:_test|_ci)$/.test(name))) throw new Conflict("示例管理仅允许本项目本机验收数据库");
  if (collectionEnabled() || config.modelCallsEnabled) throw new Conflict("请先关闭实际采集与模型调用，再管理示例数据");
}
const lock = (db: Tx) => db`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
const subject = ["角色一致性与参考图", "视频模型的成本选择", "生成额度变化与实际影响", "短片镜头节奏拆解", "创作者素材授权与协作"];
const body = (i: number) => `【示例内容，非真实新闻】${subject[i % 5]}。先固定参考图，再用两个连续镜头检查角色、光线和背景。记录每次生成条件与返工次数，用相同素材做对照。示例设定中的新功能只用于说明页面逻辑，没有真实产品发布，不代表效果承诺。正式使用前应核对官方说明与自己的实测结果。`;

/** Explicit acceptance fixtures, separate from collection and paid receipts. No external requests. */
export async function seedAcceptanceExamples(value: unknown, actor: string) {
  z.object({}).strict().parse(value); permitted();
  const existing = await read(); if (existing) return status(existing);
  if ((await sql`SELECT key FROM settings WHERE key = ${cleanupKey}`).length) throw new Conflict("上次示例图片清理尚未完成，请先重试清理");
  const pool = createImageAssets(), assets: string[] = [];
  for (const [index, color] of ["#17685e", "#52677f", "#80604a"].entries()) {
    const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${color}"/><text x="65" y="110" font-size="34" fill="white">EXAMPLE ${index + 1} / FastLaneNEWS</text><text x="65" y="255" font-size="45" fill="white">Reference → Scene → Check</text><text x="65" y="440" font-size="24" fill="white">Illustrative workflow material - no product claim</text></svg>`)).png().toBuffer();
    assets.push((await pool.put({ body: image, type: "image/png" })).id);
  }
  const window = await currentWindow(), now = new Date(), end = new Date(window.startsAt);
  return sql.begin(async db => {
    await lock(db); const prior = await read(db); if (prior) return status(prior);
    // Never occupy an existing real batch or replace its result.
    if ((await db`SELECT id FROM studio_topic_batches WHERE starts_at = ${new Date(end.getTime() - 48 * 3600_000)} AND root_batch_id IS NULL`).length) throw new Conflict("当前展示期已有真实批次，未覆盖；请保留真实数据后使用独立验收库");
    const m: Manifest = { version: 1, createdAt: now.toISOString(), sources: [], creators: [], posts: [], articles: [], batches: [], projects: [], previews: [], assets, learning: [], columns: [] };
    for (let i = 0; i < 32; i++) {
      const id = "acceptance-example-" + randomUUID(); m.sources.push(id);
      await db`INSERT INTO sources (id, name, kind, config, enabled, participation_mode, health, last_ok_at, tags)
        VALUES (${id}, ${`[示例] ${String(i + 1).padStart(2, "0")} ${subject[i % 5]}资讯`}, 'rss', ${db.json({ feedUrl: `https://example.invalid/acceptance/${id}/feed` })}, false, 'isolated', 'paused', ${now}, ${["示例", "AI影视"]})`;
      await db`INSERT INTO studio_news_profiles (source_id, description, region, language, homepage, manual_fields)
        VALUES (${id}, '验收示例来源，展示简介、地区和收录状态，不会自动访问。', ${i % 2 ? "中国" : "全球"}, 'zh', 'https://example.invalid/acceptance', ${["description", "language", "homepage"]})`;
      if (i >= 28) continue;
      const at = new Date(i < 12 ? Math.max(end.getTime() + 60_000, now.getTime() - (i + 1) * 30 * 60_000) : end.getTime() - (i < 22 ? 1 : 52) * 3600_000 - i * 60_000);
      const url = `https://example.invalid/acceptance/news/${id}`, sourceUrl = `https://example.invalid/acceptance/images/${i % 3}.png`;
      const article = await upsertMaterial({ sourceId: id, title: `[示例] ${subject[i % 5]}：${i % 2 ? "如何减少连续镜头返工，先看参考条件再决定制作方法" : "新变化适合哪一步制作流程"} ${i + 1}`, url,
        bodyText: body(i), excerpt: body(i), bodyStatus: "ok", publishedAt: at, discoveredAt: at, via: "import", media: [{ kind: "image", url: sourceUrl, alt: "[示例] 制作流程示意" }] }, db);
      m.articles.push(article.articleId);
      const images = [{ assetId: assets[i % 3]!, url: `/api/admin/studio/image-assets/${assets[i % 3]}`, sourceUrl, articleUrl: url, revision: 1, description: "[示例] 参考图与镜头检查流程", rights: "本项目生成的验收示意图，不代表新闻原图" }];
      await db`UPDATE studio_news_image_sets SET state = 'ready', images = ${db.json(images)} WHERE article_id = ${article.articleId}`;
      await pool.setReferences(`acceptance-news:${article.articleId}`, [assets[i % 3]!], db);
    }
    const platforms: CreatorPlatform[] = ["xhs", "douyin", "kuaishou", "bilibili", "weibo", "tieba", "zhihu"];
    for (const [i, platform] of platforms.entries()) {
      const id = randomUUID(); m.creators.push(id);
      await db`INSERT INTO studio_creator_accounts (id, platform, locator, homepage, name, description, follower_count, work_count, enabled, profile_state, last_checked_at, latest_published_at)
        VALUES (${id}, ${platform}, ${"example_" + id.replaceAll("-", "")}, ${`https://example.invalid/acceptance/creator/${id}`}, ${`[示例] ${subject[i % 5]}研究员`}, '示例作者，供查看资料、视频表现、评论和表达参考；并非真实账号。', ${12000 + i * 7500}, ${34 + i * 11}, false, 'ready', ${now}, ${now})`;
      await pool.setReferences(`creator-avatar:${id}`, [assets[i % 3]!], db);
      for (let j = 0; j < 3; j++) {
        const at = new Date(j === 0 ? now.getTime() - (i + 1) * 10 * 60_000 : end.getTime() - (j === 1 ? 2 : 54) * 3600_000 - i * 60_000);
        const text = body(i), metrics = { views: 18000 + i * 13000 + j * 1200, comments: 100 + i * 31, likes: 1800 + i * 230, favorites: 650 + i * 70, reposts: 100 + i * 8 };
        const post = await saveCreatorContent(db, id, platform, { externalId: "example-" + j, url: `https://example.invalid/acceptance/video/${id}/${j}`, title: `[示例] ${subject[i % 5]}，我会先演示哪一步？${j + 1}`, text,
          kind: ["tieba", "weibo"].includes(platform) ? "post" : platform === "zhihu" ? "answer" : "video", publishedAt: at.toISOString(), transcript: null, metrics,
          comments: [{ externalId: "comment-1", text: "示例评论：参考图需要保持同一个角度吗？", likes: 85, publishedAt: at.toISOString() }, { externalId: "comment-2", text: "示例评论：更关心低成本方案和失败时怎么调整。", likes: 62, publishedAt: at.toISOString() }], commentCoverage: { complete: false, repliesComplete: false, limit: 20 } });
        m.posts.push(post); await db`UPDATE studio_creator_posts SET collected_at = ${at} WHERE id = ${post}`;
        for (let point = 0; point < 3; point++) await db`INSERT INTO studio_creator_observations (id, post_id, observed_at, metrics)
          VALUES (${randomUUID()}, ${post}, ${new Date(at.getTime() + point * 5 * 60_000)}, ${db.json({ ...metrics, views: Math.round(metrics.views * (0.5 + point * 0.25)), likes: Math.round(metrics.likes * (0.5 + point * 0.25)) })})`;
        if (!["tieba", "weibo", "zhihu"].includes(platform)) await db`INSERT INTO studio_media_transcripts (post_id, source_fingerprint, result)
          SELECT id, content_fingerprint, ${db.json({ text, language: "zh", durationSeconds: 120, method: "local_asr", model: "[示例] 未执行真实转写", visualEvidence: "not_available", segments: [{ start: 0, end: 15, text: "【示例转写】先说明连续镜头变脸的问题。" }, { start: 15, end: 100, text }, { start: 100, end: 120, text: "【示例转写】最后说明条件和限制。" }], frames: [] })} FROM studio_creator_posts WHERE id = ${post}`;
        await indexHistoryMaterial(db, "creator:" + post);
      }
    }
    const ids = [...m.articles.map(id => "news:" + id), ...m.posts.map(id => "creator:" + id)];
    const evidence = (await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db, { earliestStart: new Date(0), startsAt: new Date(0), endsAt: now }, ids, true)}) all_examples`).map(r => r.evidence);
    const longColumn = { ...(await currentColumns(db))[0]!, id: "example-column-" + randomUUID(), name: "[示例] 长栏目名称：连续镜头人物一致性、分镜衔接、制作条件对照与低成本返工排查方法", version: 1, sortOrder: 45, enabled: true, isFallback: false };
    m.columns.push(longColumn.id);
    await db`INSERT INTO studio_topic_column_versions (column_id, version, definition) VALUES (${longColumn.id}, 1, ${db.json(longColumn as never)})`;
    const columns = await currentColumns(db);
    for (const material of evidence) {
      const columnId = columns[ids.indexOf(material.id) % Math.min(5, columns.length)]!.id;
      const result = { columnId, disposition: "support", summary: "[示例分析] 对比制作条件、具体步骤和适用限制。", reason: "示例依据用于演示页面，不代表模型已核实", viewerBenefit: "看清流程和成本条件", event: subject[ids.indexOf(material.id) % 5], evidenceQuotes: [material.body.slice(0, 80)], gaps: ["示例数据，未进行真实模型判断"],
        insights: { policy: "acceptance-example", commentSample: { count: material.comments?.length ?? 0, complete: false, repliesComplete: false }, commentFocus: material.comments?.length ? [{ point: "[示例] 用户关注参考条件、制作成本和失败处理", evidence: [{ commentId: material.comments[0]!.externalId, quote: material.comments[0]!.text }] }] : [], impacts: [{ effect: "[示例] 合理对照可能帮助减少返工", conditions: "需要自己用同样素材验证", kind: "inferred", evidenceQuotes: [material.body.slice(0, 80)] }] } };
      await db`INSERT INTO studio_live_material_analyses (material_id, source_key, state, result)
        SELECT material_id, knowledge->>'sourceKey', 'completed', ${db.json(result)} FROM studio_history_index WHERE material_id = ${material.id}
        ON CONFLICT (material_id, source_key) DO UPDATE SET result = EXCLUDED.result, state = 'completed'`;
    }
    for (let period = 0; period < 2; period++) {
      const endsAt = new Date(end.getTime() - period * 48 * 3600_000), startsAt = new Date(endsAt.getTime() - 48 * 3600_000);
      if ((await db`SELECT id FROM studio_topic_batches WHERE starts_at = ${startsAt} AND root_batch_id IS NULL`).length) continue;
      const batchId = randomUUID(); m.batches.push(batchId);
      const materials = evidence.filter(e => Date.parse(e.collectedAt) >= startsAt.getTime() && Date.parse(e.collectedAt) < endsAt.getTime());
      await db`INSERT INTO studio_topic_batches (id, starts_at, ends_at, frozen_at, audience, columns) VALUES (${batchId}, ${startsAt}, ${endsAt}, ${endsAt}, ${topicAudience}, ${db.json(columns as never)})`;
      for (const material of materials) await db`INSERT INTO studio_topic_batch_materials (batch_id, material_id, collected_at, evidence, source_key)
        SELECT ${batchId}, ${material.id}, ${material.collectedAt}, ${db.json(material as never)}, knowledge->>'sourceKey' FROM studio_history_index WHERE material_id = ${material.id}`;
      const historical = evidence.filter(e => Date.parse(e.collectedAt) < startsAt.getTime()).slice(0, 2);
      const result = demoDirections(materials, ["practice", "models", "news", "cases", "other"]);
      if (historical[0]) result.directions[0]!.references.push({ materialId: historical[0].id, role: "fact", quote: historical[0].body.slice(0, 80), reason: "[示例] 相同参考图问题的历史背景，保留原始日期" });
      const output: Pick<TopicReview, "verdict" | "result" | "rounds" | "decisions" | "summary"> = { verdict: "revised", result, rounds: [{ round: 1, passed: false, summary: "[示例审核] 补充适用条件", opinions: [] }, { round: 2, passed: true, summary: "[示例审核] 保留事实边界", opinions: [] }], decisions: [], summary: "[示例] 用于查看审核后选题布局，未调用模型、未产生真实审核或费用。" };
      await db`INSERT INTO studio_topic_recommendations (batch_id, state, result) VALUES (${batchId}, 'draft', ${db.json(result as never)})`;
      await db`INSERT INTO studio_topic_reviews (batch_id, state, output) VALUES (${batchId}, 'completed', ${db.json(output as never)})`;
      const fingerprints = await db<{ material_id: string; fingerprint: string }[]>`SELECT material_id, fingerprint FROM studio_history_index WHERE material_id = ANY(${historical.map(item => item.id)}::text[])`;
      await db`INSERT INTO studio_topic_history (batch_id, snapshot) VALUES (${batchId}, ${db.json({ policy: historyIndexPolicy, frozenAt: endsAt.toISOString(), candidateCount: historical.length, candidateLimit: 50, evidenceLimit: 10, omittedQueryTerms: 0, coverage: "incremental_only", items: historical.map(material => ({ material, fingerprint: fingerprints.find(row => row.material_id === material.id)!.fingerprint, reason: "[示例] 相同制作问题的历史背景", anchors: [] })) } as never)})`;
      for (let n = 0; n < (period ? 5 : 34); n++) {
        const id = randomUUID(), direction = result.directions[n % result.directions.length]!, title = direction.titles[0]! + (n >= 9 ? ` · 方案${Math.floor(n / 9) + 1}` : "");
        m.projects.push(id);
        const selected = [...materials, ...historical].filter(e => direction.references.some(ref => ref.materialId === e.id));
        const snapshot: WritingProject["snapshot"] = { batch: { id: batchId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, audience: topicAudience, columns, directions: [direction], materials: selected, references: direction.references.map(({ materialId, role }) => ({ materialId, role })), skills: await enabledWritingSkills([direction.columnId], db), reviewVerdict: "revised", languageSamples: [] };
        const content = { spoken: `[示例口播稿，可自由修改]\n\n做连续镜头时，人物明明是同一个，下一镜却像换了人，可以先查参考条件。\n\n第一步，固定角色参考图和光线，不要同时换模型、姿势和场景。第二步，用两个相邻镜头做小测试，记录条件，检查脸型、服装和背景有没有漂移。第三步，只调整一个变量，再对照前一次结果。\n\n这里展示的是验收用的假设流程，并非我亲测某款新工具。真正在你的项目里用，还要看模型支持什么参考方式，以及这套条件是否适合当前镜头。先用两镜头确认，再批量做整段，通常更容易知道问题出在哪。\n\n这篇稿子用来检查编辑、自动保存、版本、复制与图片导出，不代表真实模型写作效果。`, production: "[示例制作方案]\n\n0—15秒：对照两个镜头，指出人物变化。\n15—80秒：录屏展示固定参考条件与逐项检查。\n80—110秒：展示失败情况与调整。\n110—120秒：交代适用条件。\n\n实际时长需朗读确认。", notes: `[示例素材与备注]\n\n![示例制作流程](/api/admin/studio/image-assets/${assets[n % 3]})\n\n示意图由本项目生成，不是新闻原图。来源链接均为 example.invalid，供标识出处格式。` };
        await db`INSERT INTO studio_writing_projects (id, request_id, creation_hash, batch_id, title, title_options, instructions, snapshot, content)
          VALUES (${id}, ${randomUUID()}, ${sha256(id)}, ${batchId}, ${title}, ${db.json(direction.titles)}, '[示例] 仅用于验收页面，可修改保存。', ${db.json(snapshot as never)}, ${db.json(content)})`;
        await attachWritingSourceImages(db, id, [...selected, ...materials.filter(e => e.sourceImages?.images.length).slice(0, 3)]);
        await protectWritingImages(db, id, 1, content);
        await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source)
          SELECT id, 1, title, title_options, instructions, content, 'created' FROM studio_writing_projects WHERE id = ${id}`;
        if (n < (period ? 3 : 4)) {
          await db`UPDATE studio_writing_projects SET version = 2, state = 'final' WHERE id = ${id}`;
          await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source)
            SELECT id, 2, title, title_options, instructions, content, 'final' FROM studio_writing_projects WHERE id = ${id}`;
          await protectWritingImages(db, id, 2, content); await recordLanguageSample(db, { id, version: 2, snapshot });
        }
      }
    }
    const sampleProjectId = m.projects[0]!, [sample] = await db<{ title: string; content: { spoken: string } }[]>`SELECT title, content FROM studio_writing_projects WHERE id = ${sampleProjectId}`;
    const training = [{ projectId: sampleProjectId, version: 2, title: sample!.title, spoken: sample!.content.spoken, columnIds: ["practice"], confirmedAt: now.toISOString(), source: "confirmed_final" }];
    for (let n = 0; n < 3; n++) {
      const id = randomUUID(); m.learning.push(id);
      await db`INSERT INTO studio_style_learning (id, column_id, input_hash, input, state, result, job_id, created_at)
        VALUES (${id}, 'practice', ${sha256(id)}, ${db.json({ column: columns.find(c => c.id === "practice"), training, heldOut: [], observedSamples: training.map(({ projectId, version }) => ({ projectId, version })), skills: [], config: { version: 0, skillId: null, lockedRules: [] }, baseSkill: null } as never)},
        'retained', ${db.json({ candidate: { summary: "[示例] 用具体问题、对照步骤和适用条件组织口播", rules: [{ key: "example_opening", body: "[示例] 先说具体制作问题，再展示对照，不写虚构亲测。", evidence: [{ projectId: sampleProjectId, version: 2, quote: sample!.content.spoken.slice(0, 120) }] }] }, evaluations: [], activatedSkill: null, reason: "[示例] 仅供查看学习记录，未调用模型和启用规则。" })}, ${randomUUID()}, ${new Date(now.getTime() - n * 86400_000)})`;
    }
    await db`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${db.json(m as never)}, ${actor})`;
    await audit(actor, "studio.acceptance.seed", "acceptance:examples", null, null, status(m), { db });
    return status(m);
  });
}

function demoDirections(materials: TopicBatchMaterial[], columnIds: string[]): TopicRecommendationResult {
  const definitions = ["先固定参考，再做两镜头对照：连续镜头人物变化时，怎样快速定位返工原因；从角色、服装、光线到场景，只改一个变量并记录结果，避免一次换掉所有条件后无法复现", "同一素材换不同参考条件，怎么设计一个能复现的测试", "视频模型怎么选：先算可用镜头的成本，再比较生成次数", "图像、配音和视频工具如何放进一个可执行流程", "额度和功能变化，会影响创作者哪一步决策", "看到更新公告后，先确认哪些限制", "拆一个短片的开头、演示节奏和结尾", "从失败镜头整理一份检查清单", "素材授权和团队交接，需要留什么证据"];
  const draft = { directions: definitions.map((title, n) => {
    const news = materials.filter(m => m.kind === "news"), creators = materials.filter(m => m.kind !== "news");
    const chosen = [...new Map([news[n % news.length] ?? materials[0]!, creators[n % creators.length] ?? materials[(n + 1) % materials.length]!, creators[(n + 1) % creators.length] ?? materials[0]!].map(item => [item.id, item])).values()];
    return { id: `example-direction-${n + 1}`, columnId: columnIds[Math.min(4, Math.floor(n / 2))]!, eventKey: `example-event-${n + 1}`, question: "[示例] " + title, viewerBenefit: "看懂具体操作、适用条件与制作成本；这是一份展示布局的假设选题。", whyNow: "[示例] 近期资讯和作者讨论出现相同制作问题，需通过真实资料验证。", angle: "从一个可演示的问题切入，对比条件再给建议。",
      usage: { steps: ["准备同一份参考素材", "用两个镜头做对照并记录条件", "根据失败点只改一个变量"], conditions: ["确认工具实际支持的功能"], limitations: ["示例不代表真实产品、流量或实测结论"] }, titles: ["[示例] " + title, "[示例] 先用两个镜头检查，再决定完整流程", "[示例] 少返工，先看清这些适用条件"], preferredTitle: 0,
      structure: { opening: "先给具体制作问题，避免套话", rhythm: "展示对照，再解释条件；每段只推进一个动作", ending: "交代适用边界和下一步" }, references: chosen.map((m, i) => ({ materialId: m.id, role: i && m.kind !== "news" ? "expression" as const : "fact" as const, quote: m.body.slice(0, 80), reason: "[示例] 参考操作步骤与说明限制的表达" })),
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 85, practical: 85, evidence: 80, freshness: 75, demand: null, distinctiveness: 75 } };
  }), assignments: materials.map(m => ({ materialId: m.id, columnId: columnIds[0]!, disposition: "background" as const, directionIds: [] as string[], reason: "[示例] 用于演示完整材料归属" })) };
  for (const assignment of draft.assignments) { const used = draft.directions.filter(d => d.references.some(r => r.materialId === assignment.materialId)); if (used.length) { assignment.directionIds = used.map(d => d.id); assignment.columnId = used[0]!.columnId; } }
  return scoreTopicDraft(draft, materials.map(material => ({ material })));
}

export async function clearAcceptanceExamples(value: unknown, actor: string) {
  z.object({}).strict().parse(value); permitted();
  const assets = await sql.begin(async db => {
    await lock(db); const m = await read(db); if (!m) return (await db<{ value: string[] }[]>`SELECT value FROM settings WHERE key = ${cleanupKey}`)[0]?.value ?? [];
    const related = [...m.batches, ...m.projects, ...m.posts, ...m.articles].map(id => `%${id}%`);
    const [outside] = await db`SELECT id FROM studio_writing_projects WHERE NOT (id = ANY(${m.projects}::uuid[])) AND
      (batch_id = ANY(${m.batches}::uuid[]) OR snapshot::text LIKE ANY(${related}::text[])) LIMIT 1`;
    if (outside) throw new Conflict("有另建稿件引用了示例，请先保留或移除这些稿件，再清理；本次没有删除任何内容");
    const [frozen] = await db`SELECT batch_id FROM studio_topic_batch_materials WHERE NOT (batch_id = ANY(${m.batches}::uuid[])) AND material_id = ANY(${[...m.posts.map(id => "creator:" + id), ...m.articles.map(id => "news:" + id)]}::text[]) LIMIT 1`;
    const [supplemented] = await db`SELECT id FROM studio_topic_batches WHERE NOT (id = ANY(${m.batches}::uuid[])) AND supplemental_materials::text LIKE ANY(${related}::text[]) LIMIT 1`;
    if (frozen || supplemented) throw new Conflict("其他批次已引用示例，未清理；请先保留并处理关联批次");
    const [outsideHistory] = await db`SELECT batch_id FROM studio_topic_history WHERE NOT (batch_id = ANY(${m.batches}::uuid[])) AND snapshot::text LIKE ANY(${related}::text[]) LIMIT 1`;
    const [outsidePreview] = await db`SELECT id FROM studio_topic_previews WHERE NOT (id = ANY(${m.previews}::uuid[])) AND input::text LIKE ANY(${related}::text[]) LIMIT 1`;
    const [outsideLearning] = await db`SELECT id FROM studio_style_learning WHERE NOT (id = ANY(${m.learning}::uuid[])) AND input::text LIKE ANY(${related}::text[]) LIMIT 1`;
    const [outsideSupplement] = await db`SELECT starts_at FROM studio_topic_supplement_windows WHERE materials::text LIKE ANY(${related}::text[]) LIMIT 1`;
    if (outsideHistory || outsidePreview || outsideLearning || outsideSupplement) throw new Conflict("其他选题或学习记录已引用示例，本次未清理；请先保留并处理这些关联");
    // Known owned children only. Unexpected foreign keys abort the entire transaction safely.
    for (const table of ["studio_language_samples", "studio_writing_revisions", "studio_writing_generations", "studio_writing_images", "studio_writing_versions"]) await db`DELETE FROM ${db(table)} WHERE project_id = ANY(${m.projects}::uuid[])`;
    await db`DELETE FROM studio_writing_projects WHERE id = ANY(${m.projects}::uuid[])`;
    await db`DELETE FROM studio_style_learning_steps WHERE learning_id = ANY(${m.learning}::uuid[])`;
    await db`DELETE FROM studio_style_learning WHERE id = ANY(${m.learning}::uuid[])`;
    for (const table of ["studio_topic_feedback", "studio_topic_review_steps", "studio_topic_reviews", "studio_topic_recommendations", "studio_topic_material_analyses", "studio_topic_batch_materials"]) await db`DELETE FROM ${db(table)} WHERE batch_id = ANY(${m.batches}::uuid[])`;
    await db`DELETE FROM studio_topic_batches WHERE id = ANY(${m.batches}::uuid[])`;
    await db`DELETE FROM studio_topic_previews WHERE id = ANY(${m.previews}::uuid[])`;
    await db`DELETE FROM studio_creator_observations WHERE post_id = ANY(${m.posts}::uuid[])`;
    await db`DELETE FROM studio_media_transcripts WHERE post_id = ANY(${m.posts}::uuid[])`;
    await db`DELETE FROM studio_creator_posts WHERE id = ANY(${m.posts}::uuid[])`;
    await db`DELETE FROM studio_creator_accounts WHERE id = ANY(${m.creators}::uuid[])`;
    await db`DELETE FROM articles WHERE id = ANY(${m.articles}::text[])`;
    await db`DELETE FROM studio_news_profiles WHERE source_id = ANY(${m.sources}::text[])`;
    await db`DELETE FROM sources WHERE id = ANY(${m.sources}::text[])`;
    await db`DELETE FROM studio_topic_column_versions WHERE column_id = ANY(${m.columns}::text[])`;
    const ownerPatterns = [...m.projects.map(id => `%${id}%`), ...m.creators.map(id => `creator-avatar:${id}`), ...m.articles.map(id => `acceptance-news:${id}`)];
    await db`DELETE FROM studio_image_references WHERE owner LIKE ANY(${ownerPatterns}::text[])`;
    await db`DELETE FROM settings WHERE key = ${key}`;
    await db`INSERT INTO settings (key, value, updated_by) VALUES (${cleanupKey}, ${db.json(m.assets)}, ${actor}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await audit(actor, "studio.acceptance.clear", "acceptance:examples", null, status(m), { active: false }, { db });
    return m.assets;
  }).catch(error => { if ((error as { code?: string }).code === "23503") throw new Conflict("示例仍被其他内容引用，本次没有删除；请先处理关联后重试"); throw error; });
  if (assets.length) {
    try { await createImageAssets().prune(new Date(Date.now() + 1000), assets); await sql`DELETE FROM settings WHERE key = ${cleanupKey}`; }
    catch { throw new Conflict("示例内容已移除，少量示例图片清理未完成，请再次点击清理重试；受其他稿件引用的图片会保留"); }
  }
  return status();
}
