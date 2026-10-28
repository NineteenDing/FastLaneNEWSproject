import sharp from "sharp";
import { marked } from "marked";
import { load } from "cheerio";
import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { assertImageProcessingAllowed } from "@aihot/backend/media/processing";
import { createImageAssets } from "./image-assets.ts";
import type { TopicBatchMaterial, WritingContent, WritingImage } from "../contracts.ts";
import { imageAssetReferences, isManagedImageUrl } from "../image-references.ts";

type Row = Omit<WritingImage, "url" | "createdAt"> & { createdAt: Date };
const project = (row: Row): WritingImage => ({ ...row, url: `/api/admin/studio/image-assets/${row.assetId}`, createdAt: row.createdAt.toISOString() });

export async function writingImages(id: string, db: Db = sql) {
  z.uuid().parse(id);
  if (!(await db`SELECT id FROM studio_writing_projects WHERE id = ${id}`).length) return null;
  const rows = await db<Row[]>`SELECT image_id AS "assetId", name, source, created_at AS "createdAt" FROM studio_writing_images
    WHERE project_id = ${id} AND removed_at IS NULL ORDER BY created_at, image_id`;
  return { rows: rows.map(project) };
}

/** Adopt the saved batch evidence only; never fetch or hydrate current article images. */
export async function attachWritingSourceImages(db: Tx, id: string, materials: TopicBatchMaterial[]) {
  const attached = new Set<string>();
  for (const material of materials) for (const [index, image] of (material.sourceImages?.images ?? []).entries()) {
    if (attached.has(image.assetId)) continue;
    const name = (image.description.trim() || `${material.title} · 配图${index + 1}`).slice(0, 180);
    const source: WritingImage["source"] = { kind: "news", materialId: material.id, originalUrl: image.sourceUrl,
      articleUrl: image.articleUrl, revision: image.revision, rights: image.rights };
    await db`INSERT INTO studio_writing_images (project_id, image_id, name, source)
      VALUES (${id}, ${image.assetId}, ${name}, ${db.json(source)}) ON CONFLICT DO NOTHING`;
    await createImageAssets().setReferences(`draft-image:${id}:${image.assetId}`, [image.assetId], db);
    attached.add(image.assetId);
  }
}

/** Keep attachment visibility and per-draft ownership while sharing the existing image bytes. */
export async function copyWritingImages(db: Tx, from: string, to: string, content: WritingContent) {
  const referenced = writingImageIds(content);
  const rows = await db<Array<{ imageId: string; name: string; source: WritingImage["source"]; removedAt: Date | null }>>`
    SELECT image_id AS "imageId", name, source, removed_at AS "removedAt" FROM studio_writing_images
    WHERE project_id = ${from} AND (removed_at IS NULL OR image_id = ANY(${referenced}::text[]))`;
  for (const image of rows) {
    await db`INSERT INTO studio_writing_images (project_id, image_id, name, source, removed_at)
      VALUES (${to}, ${image.imageId}, ${image.name}, ${db.json(image.source)}, ${image.removedAt})`;
    if (!image.removedAt) await createImageAssets().setReferences(`draft-image:${to}:${image.imageId}`, [image.imageId], db);
  }
  await protectWritingImages(db, to, 1, content);
}

export async function uploadWritingImage(id: string, input: unknown, actor: string) {
  z.uuid().parse(id);
  const value = z.object({ name: z.string().trim().min(1).max(180), contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    bodyBase64: z.string().min(4).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).strict().parse(input);
  if (!(await sql`SELECT id FROM studio_writing_projects WHERE id = ${id}`).length) return null;
  const bytes = Buffer.from(value.bodyBase64, "base64");
  z.custom<Buffer>(body => Buffer.isBuffer(body) && body.length > 0 && body.length <= 5 * 1024 ** 2 && body.toString("base64") === value.bodyBase64,
    "请选择不超过5MiB的完整图片").parse(bytes);
  assertImageProcessingAllowed();
  let normalized: Buffer;
  try {
    const decoder = sharp(bytes, { limitInputPixels: 20_000_000, failOn: "error" });
    const metadata = await decoder.metadata();
    if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) throw new Error("not a still raster image");
    normalized = await decoder.rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer();
  } catch {
    throw new z.ZodError([{ code: "custom", path: ["bodyBase64"], message: "图片无法解码；请选择静态PNG、JPEG或WebP，像素不超过2000万" }]);
  }
  const assets = createImageAssets(), image = await assets.put({ body: normalized, type: "image/png" });
  return sql.begin(async db => {
    await db`INSERT INTO studio_writing_images (project_id, image_id, name, source)
      VALUES (${id}, ${image.id}, ${value.name}, ${db.json({ kind: "upload" })}) ON CONFLICT (project_id, image_id) DO UPDATE SET removed_at = NULL`;
    await assets.setReferences(`draft-image:${id}:${image.id}`, [image.id], db);
    const [row] = await db<Row[]>`SELECT image_id AS "assetId", name, source, created_at AS "createdAt" FROM studio_writing_images
      WHERE project_id = ${id} AND image_id = ${image.id}`;
    await audit(actor, "studio.writing.image.upload", `draft:${id}`, null, null, { imageId: image.id }, { db });
    return project(row!);
  });
}

export async function removeWritingImage(id: string, assetId: string, input: unknown, actor: string) {
  z.uuid().parse(id); z.string().regex(/^[a-f0-9]{64}$/).parse(assetId);
  const value = z.object({ version: z.number().int().positive() }).strict().parse(input);
  return sql.begin(async db => {
    const [draft] = await db`SELECT version::int FROM studio_writing_projects WHERE id = ${id} FOR UPDATE`;
    if (!draft) return null;
    if (draft.version !== value.version) throw new Conflict("稿件已更新，请刷新并对比后再移除素材");
    const [image] = await db`UPDATE studio_writing_images SET removed_at = now() WHERE project_id = ${id} AND image_id = ${assetId} AND removed_at IS NULL RETURNING image_id`;
    if (!image) return { removed: false };
    await createImageAssets().setReferences(`draft-image:${id}:${assetId}`, [], db);
    await audit(actor, "studio.writing.image.remove", `draft:${id}`, null, null, { imageId: assetId }, { db });
    return { removed: true };
  });
}

/** Each saved version keeps its own durable reference, including after removal from the attachment list. */
export async function protectWritingImages(db: Tx, id: string, version: number, content: WritingContent, gallery: true | string[] = []) {
  // Draft attachments already have removable owners; only confirmation freezes the full gallery.
  const visible = gallery === true ? (await db<{ image_id: string }[]>`SELECT image_id FROM studio_writing_images WHERE project_id = ${id} AND removed_at IS NULL`).map(image => image.image_id) : gallery;
  const ids = [...new Set([...writingImageIds(content), ...visible])];
  if (!ids.length) return;
  const owned = await db`SELECT image_id FROM studio_writing_images WHERE project_id = ${id} AND image_id IN ${db(ids)}`;
  if (owned.length !== ids.length) throw new Conflict("图片尚未关联到这篇稿件，请先上传或从本稿素材中插入");
  await createImageAssets().setReferences(`draft-version:${id}:${version}`, ids, db);
}

export function writingImageIds(content: WritingContent) {
  const ids = new Set<string>();
  for (const text of Object.values(content)) {
    for (const match of text.matchAll(imageAssetReferences())) ids.add(match[1]!);
  }
  for (const { src } of imageSources(content)) if (isManagedImageUrl(src)) ids.add(src.slice(src.lastIndexOf("/") + 1));
  return [...ids];
}

function imageSources(content: WritingContent) {
  const sources: Array<{ src: string | undefined; html: boolean }> = [];
  for (const text of Object.values(content)) marked.walkTokens(marked.lexer(text), token => {
    if (token.type === "image") sources.push({ src: token.href, html: false });
    if (token.type === "html") {
      const html = load(token.raw, {}, false);
      if (html("source[srcset], img[srcset]").length) sources.push({ src: undefined, html: true });
      for (const image of html("img").toArray()) sources.push({ src: html(image).attr("src"), html: true });
    }
  });
  return sources;
}

/** Generation and offline export share Markdown/HTML parsing, including decoded attributes. */
export function validateWritingImageSources(content: WritingContent, allowed: (src: string) => boolean) {
  const urls = new Set<string>();
  for (const { src, html } of imageSources(content)) {
    if (typeof src !== "string" || !allowed(src)) throw new Conflict(html
      ? "HTML图片地址无法安全离线导出，请从本稿素材插入标准Markdown图片后重试"
      : "存在尚未导入的图片，请先上传到本稿素材再导出完整离线包");
    urls.add(src);
  }
  return [...urls];
}
