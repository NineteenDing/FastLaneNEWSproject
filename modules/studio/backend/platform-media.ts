import path from "node:path";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { createMediaTranscriptionProcessor, parseMediaRecognition, type MediaRecognition, type MediaVisuals } from "./media-transcription.ts";
import { createLocalAsr } from "./local-asr.ts";
import { collectMediaCreator, platformMediaSource } from "./mediacrawler.ts";
import { platformSessionSecret } from "./platform-sessions.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const referers: Record<string, string> = { xhs: "https://www.xiaohongshu.com/", weibo: "https://m.weibo.cn/", douyin: "https://www.douyin.com/", kuaishou: "https://www.kuaishou.com/", bilibili: "https://www.bilibili.com/" };

/** Platform media addresses come from the fixed upstream collector, never a manual URL field. */
export function createPlatformMediaProcessor(options: {
  recognize?: (input: { file: string; signal: AbortSignal }) => Promise<MediaRecognition>;
  frames?: (input: { file: string; signal: AbortSignal }) => Promise<MediaVisuals>;
} = {}) {
  const local = createLocalAsr({ python: path.resolve(root, process.env.STUDIO_ASR_PYTHON || "runtime/asr-env/Scripts/python.exe"),
    modelDirectory: path.resolve(root, process.env.STUDIO_ASR_MODEL_DIRECTORY || "runtime/asr-model-large-v3-turbo-int8"), cwd: root });
  return createMediaTranscriptionProcessor({
    recognize: options.recognize ?? local.recognize,
    frames: options.frames ?? local.frames,
    async resolve(post, options) {
      const referer = referers[post.platform];
      if (!referer) throw new Conflict("此平台的媒体地址适配尚未接通");
      const [row] = await sql`SELECT p.content->'media' AS media, c.locator FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id WHERE p.id = ${post.id} AND p.content_fingerprint = ${post.fingerprint}`;
      let resolved = row?.media;
      if ((post.platform === "bilibili" || post.platform === "weibo" || post.platform === "xhs" || post.platform === "douyin" || post.platform === "kuaishou") && row) {
        const session = await platformSessionSecret(post.platform);
        if (!session.readable) throw new Conflict("平台会话无法读取，请重新保存后再处理视频");
        const context = post.platform === "xhs" ? platformMediaSource.safeParse(resolved).data?.xhsAccess : undefined;
        if (post.platform === "xhs" && !context?.xsec_token) throw new Conflict("缺少这条笔记的访问参数，请重新采集原作品后处理视频");
        const result = await collectMediaCreator({ platform: post.platform, locator: row.locator, videoId: post.externalId, cookie: session.cookie, ...(context ? { context } : {}) }, options);
        if (result.profile.externalId !== row.locator) throw new Conflict("平台返回了其他作者的作品，未开始下载");
        resolved = result.posts.find(item => item.externalId === post.externalId)?.media;
      }
      const media = platformMediaSource.safeParse(resolved);
      if (!media.success || !media.data.videoUrls.length) throw new Conflict("尚未取得可下载的视频地址，请重新采集原作品或检查平台状态");
      let subtitles: MediaRecognition | undefined;
      if (post.platform === "bilibili" && media.data.durationSeconds) {
        const ranks = ["zh-CN", "zh-Hans", "ai-zh", "zh", "en", "ai-en"];
        const rank = (language: string) => { const index = ranks.indexOf(language); return index < 0 ? ranks.length : index; };
        const tracks = [...(media.data.subtitleTracks ?? [])].sort((a, b) => rank(a.language) - rank(b.language)).slice(0, 3);
        for (const track of tracks) {
          try {
            const response = await guardedFetch(track.url, { headers: { Referer: referer }, timeoutMs: 10000, maxBytes: 1024 ** 2, signal: options.signal });
            if (response.status !== 200) continue;
            const caption = z.object({ body: z.array(z.object({ from: z.number().finite(), to: z.number().finite(), content: z.string() }).passthrough()).min(1).max(20000) }).passthrough().parse(JSON.parse(response.body.toString("utf8")));
            subtitles = parseMediaRecognition({ language: track.language, durationSeconds: media.data.durationSeconds,
              model: `bilibili:platform-subtitle:${track.language}`, segments: caption.body.map(line => ({ start: line.from, end: line.to, text: line.content })) });
            break;
          } catch { options.signal.throwIfAborted(); /* Invalid/inaccessible tracks never masquerade as full text; use the next candidate or local ASR. */ }
        }
      }
      return { url: media.data.videoUrls[0]!, backupUrls: media.data.videoUrls.slice(1), kind: "video", headers: { Referer: referer }, ...(subtitles ? { subtitles } : {}) };
    },
  });
}
