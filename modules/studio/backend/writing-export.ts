import { Readable } from "node:stream";
import { Zip, ZipPassThrough } from "fflate";
import { marked } from "marked";
import { load } from "cheerio";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { writingProject, writingVersion, changeWritingVersion } from "./writing-projects.ts";
import { createImageAssets } from "./image-assets.ts";
import { writingImageIds, writingImages, validateWritingImageSources } from "./writing-images.ts";
import { imageAssetReferences, isManagedImageUrl } from "../image-references.ts";
import type { WritingImage } from "../contracts.ts";
import type { WritingContent, WritingVersion } from "../contracts.ts";

const limitBytes = 512 * 1024 ** 2;
const htmlLimitBytes = 32 * 1024 ** 2;
type Image = Pick<WritingImage, "assetId" | "name" | "source"> & { bytes: string; type: string };

/** Emits one image at a time with backpressure; no export package is written to the system disk. */
async function* archive(root: string, texts: Record<string, string>, images: Image[]) {
  const pending: Uint8Array[] = [];
  let failure: Error | null = null, outputBytes = 0;
  const zip = new Zip((error, chunk) => { if (error) failure = error; else pending.push(chunk); });
  function* output() {
    if (failure) throw failure;
    while (pending.length) {
      const chunk = pending.shift()!; outputBytes += chunk.byteLength;
      if (outputBytes > limitBytes) throw new Error("导出超过512MiB限制，未交付截断包");
      yield chunk;
    }
  }
  try {
    for (const [name, text] of Object.entries(texts)) {
      const entry = new ZipPassThrough(`${root}/${name}`); zip.add(entry); entry.push(Buffer.from(text, "utf8"), true); yield* output();
    }
    const assets = createImageAssets();
    for (const image of images) {
      const saved = await assets.read(image.assetId);
      if (!saved) throw new Error("稿件图片缺失，导出尚未完成");
      const entry = new ZipPassThrough(`${root}/${imageFile(image)}`); zip.add(entry); entry.push(saved.body, true); yield* output();
    }
    zip.end(); yield* output();
  } finally { zip.terminate(); pending.length = 0; }
}

function imageFile(image: Image) {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[image.type];
  if (!extension) throw new Conflict("图片类型尚不支持导出");
  return `images/${image.assetId}.${extension}`;
}

function assertOfflineImages(content: WritingContent, rewritten = false) {
  const allowed = rewritten ? (src: unknown) => typeof src === "string" && /^images\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(src) : isManagedImageUrl;
  validateWritingImageSources(content, allowed);
}

function offlineHtml(title: string, markdown: string, images: Map<string, string>) {
  const $ = load(marked.parse(markdown, { async: false }), {}, false);
  $("img").each((_index, element) => {
    const image = $(element), data = images.get(image.attr("src") ?? "");
    if (!data) throw new Conflict("存在未保存的图片，请补齐后导出");
    image.attr("src", data);
  });
  const body = sanitizeHtml($.html(), { allowedTags: ["h1", "h2", "h3", "h4", "p", "br", "hr", "ul", "ol", "li", "strong", "em", "blockquote", "pre", "code", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "del"],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "title"] }, allowedSchemes: ["http", "https"], allowedSchemesByTag: { img: ["data"] }, allowProtocolRelative: false });
  const escapedTitle = title.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapedTitle}</title><style>body{max-width:800px;margin:40px auto;padding:0 24px;color:#243738;background:#fff;font:16px/1.85 system-ui,'Microsoft YaHei',sans-serif;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4}h2{margin-top:36px}img{display:block;max-width:100%;height:auto;margin:20px auto}pre{white-space:pre-wrap}a{color:#28635a}table{border-collapse:collapse}td,th{border:1px solid #ccd8d5;padding:8px}</style></head><body>${body}</body></html>`;
  if (Buffer.byteLength(html) > htmlLimitBytes) throw new Conflict("单文件HTML超过32MiB，请改用ZIP导出");
  return html;
}

export async function exportWriting(id: string, input: unknown, actor: string) {
  z.uuid().parse(id);
  const value = z.object({ version: z.number().int().positive(), mode: z.enum(["draft", "final"]), format: z.enum(["zip", "html"]).default("zip") }).strict().parse(input);
  const project = await writingProject(id);
  if (!project) return null;
  if (project.version !== value.version) throw new Conflict("稿件已更新，请先保存并导出当前版本");
  const frozen = await writingVersion(id, value.version);
  if (!frozen) throw new Conflict("稿件版本尚未保存，请保存后重试");
  let version = frozen;
  assertOfflineImages(version.content);
  // Confirmed exports reuse the retained gallery; later attachment edits cannot rewrite it.
  const galleryIds = value.mode === "final" && project.state === "final"
    ? (await sql<{ image_id: string }[]>`SELECT image_id FROM studio_image_references WHERE owner = ${`draft-version:${id}:${version.version}`}`).map(image => image.image_id)
    : (await writingImages(id))?.rows.map(image => image.assetId) ?? [];
  const ids = [...new Set([...writingImageIds(version.content), ...galleryIds])];
  if (ids.length > 1000) throw new Conflict("图片过多，请拆分稿件后导出");
  const images = ids.length ? await sql<Image[]>`SELECT i.image_id AS "assetId", i.name, i.source, a.bytes, a.content_type AS type
    FROM studio_writing_images i JOIN studio_image_assets a ON a.id = i.image_id AND a.state = 'ready'
    WHERE i.project_id = ${id} AND i.image_id IN ${sql(ids)} ORDER BY i.image_id` : [];
  if (images.length !== ids.length) throw new Conflict("稿件图片缺失或尚未保存，请补齐后重新导出");
  const rewrite = (text: string) => text.replace(imageAssetReferences(),
    (_match, hash: string) => imageFile(images.find(image => image.assetId === hash)!));
  const sources = project.snapshot.materials.map(material => `- ${material.source.name}：${material.title}\n  原文：${material.url}\n  用途：${project.snapshot.references.filter(ref => ref.materialId === material.id).map(ref => ({ fact: "事实依据", expression: "表达参考", counterpoint: "反例与限制" })[ref.role]).join("、")}`).join("\n\n");
  const content: WritingContent = { spoken: rewrite(version.content.spoken), production: rewrite(version.content.production), notes: rewrite(version.content.notes) };
  const gallery = images.map(image=>`![${image.name.replace(/[\[\]\\]/g,'\\$&')}](${imageFile(image)})`).join('\n\n');
  // Noncanonical HTML entities can survive literal rewriting. Never ship those as a seemingly complete ZIP.
  assertOfflineImages(content, true);
  const documents = (version: WritingVersion) => ({ "口播稿.md": `# ${version.title}\n\n${content.spoken}\n`, "制作方案.md": `# 制作方案\n\n${content.production}\n`,
    "素材与备注.md": `# 素材与备注\n\n${content.notes}\n`, "图片素材.md": `# 图片素材\n\n${gallery}\n`, "来源清单.md": `# 来源清单\n\n${sources}\n`,
    "完整制作稿.md": `# ${version.title}\n\n${value.mode === "final" ? "定稿" : "草稿"} · 版本 ${version.version}\n\n## 口播正文\n\n${content.spoken}\n\n## 制作方案\n\n${content.production}\n\n## 素材与备注\n\n${content.notes}\n\n## 图片素材\n\n${gallery}\n\n## 来源\n\n${sources}\n`,
    "manifest.json": JSON.stringify({ projectId: id, version: version.version, state: value.mode, title: version.title, savedAt: version.createdAt,
      skills: project.snapshot.skills.map(({ id, version, name }) => ({ id, version, name })), images: images.map(({ assetId, name, source }) => ({ assetId, name, source })) }, null, 2),
  });
  let texts = documents(version);
  const estimate = images.reduce((sum, image) => sum + Number(image.bytes), 0) + Object.values(texts).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0) + (images.length + Object.keys(texts).length) * 2048 + 65536;
  if (estimate > limitBytes) throw new Conflict("导出包超过512MiB预算，请拆分稿件或减少图片");
  const embedded = new Map<string, string>();
  if (value.format === "html" && images.reduce((sum, image) => sum + Number(image.bytes) * 4 / 3, 0) + Buffer.byteLength(texts["完整制作稿.md"]) + 65536 > htmlLimitBytes)
    throw new Conflict("单文件HTML超过32MiB，请改用ZIP导出");
  try {
    for (const image of images) {
      const saved = await createImageAssets().read(image.assetId); if (!saved) throw new Error("missing image");
      if (value.format === "html") embedded.set(imageFile(image), `data:${saved.type};base64,${saved.body.toString("base64")}`);
    }
  } catch {
    throw new Conflict("图片暂不可读取，请检查素材存储或补齐图片后重新导出");
  }
  // Render and validate before a final export records the user's confirmed snapshot.
  const previewVersion = value.mode === "final" && project.state !== "final" ? { ...version, version: version.version + 1 } : version;
  const html = value.format === "html" ? offlineHtml(previewVersion.title, documents(previewVersion)["完整制作稿.md"], embedded) : null;
  if (value.mode === "final") {
    const confirmed = await changeWritingVersion(id, { version: value.version }, "final", actor, ids);
    if (!confirmed) throw new Conflict("稿件暂不可用，请刷新后重试");
    const saved = await writingVersion(id, confirmed.version);
    if (!saved) throw new Conflict("定稿未能读取，请刷新后重试");
    version = saved; texts = documents(version);
  }
  const name = `FastLaneNEWS-${id.slice(0, 8)}-v${version.version}-${value.mode}`;
  return html !== null ? { version: version.version, name: `${name}.html`, type: "text/html; charset=utf-8", stream: Readable.from([html]) }
    : { version: version.version, name: `${name}.zip`, type: "application/zip", stream: Readable.from(archive(name, texts, images), { objectMode: false, highWaterMark: 65536 }) };
}
