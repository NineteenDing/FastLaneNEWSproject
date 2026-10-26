import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { resizeImage } from "@aihot/backend/media/images";
import { createImageAssets } from "./image-assets.ts";

/** Upstream bytes are decoded and stored before the account publication transaction. */
export async function prepareCreatorAvatar(url: string | null) {
  if (!url) return null;
  try {
    const response = await guardedFetch(url, { timeoutMs: 5000, maxBytes: 2 * 1024 ** 2 });
    if (response.status !== 200) return null;
    const image = await resizeImage(response.body, response.headers.get("content-type") ?? "", "avatar");
    if (image.body.length > 128 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.type)) return null;
    return (await createImageAssets().put(image)).id;
  } catch { return null; }
}

/** Reading an avatar never makes an upstream request, including after unfollowing. */
export async function creatorAvatar(id: string, input: unknown = {}) {
  z.uuid().parse(id);
  const { v } = z.object({ v: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(input);
  const owner = "creator-avatar:" + id;
  const [row] = await sql<{ image_id: string }[]>`SELECT image_id FROM studio_image_references
    WHERE ${v ? sql`owner IN (${owner}, ${owner + ":" + v}) AND image_id = ${v}` : sql`owner = ${owner}`} LIMIT 1`;
  return row ? createImageAssets().read(row.image_id) : null;
}
