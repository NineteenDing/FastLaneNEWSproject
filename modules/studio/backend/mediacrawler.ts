import { execFile, spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Script, createContext } from "node:vm";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import { sha256 } from "@aihot/backend/lib/ids";
import { withCollectorPage } from "./collector-browser.ts";
import type { Page } from "playwright-core";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const date = z.iso.datetime().nullable();
const comment = z.object({ externalId: z.string().max(100), text: z.string().max(20000), likes: count, publishedAt: date, floor: z.number().int().positive().optional(), parentExternalId: z.string().min(1).max(100).optional() }).strict();
export const platformMediaSource = z.object({ videoUrls: z.array(z.url().max(8000)).max(3), durationSeconds: z.number().finite().positive().max(7200).optional(),
  xhsAccess: z.object({ xsec_token: z.string().max(2000), xsec_source: z.string().max(200) }).strict().optional(),
  subtitleTracks: z.array(z.object({ language: z.string().min(1).max(20), url: z.url().max(8000) }).strict()).max(20).optional() }).strict();
export const mediaCreatorResult = z.object({
  profile: z.object({ externalId: z.string().max(200), stableId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(), canonicalLocator: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(), name: z.string().max(500).nullable(), description: z.string().max(10000).nullable(),
    avatar: z.string().max(4000).nullable(), followerCount: count, workCount: count }).strict(),
  posts: z.array(z.object({ externalId: z.string().max(200), url: z.url().max(4000), title: z.string().max(2000), text: z.string().max(100000),
    kind: z.enum(["video", "post", "image_text", "answer", "article"]).default("video"),
    media: platformMediaSource.optional(),
    parent: z.object({ kind: z.enum(["question", "column"]), url: z.url().max(4000), title: z.string().max(2000) }).strict().optional(),
    publishedAt: date, transcript: z.null(), metrics: z.object({ views: count, comments: count, likes: count.optional(), reposts: count.optional(), favorites: count.optional() }).strict(), comments: z.array(comment).max(40),
    commentCoverage: z.object({ complete: z.boolean(), repliesComplete: z.boolean(), limit: z.literal(20),
      replySample: z.object({ count: z.number().int().min(0).max(20), limit: z.literal(20), parentsChecked: z.number().int().min(0).max(20), parentsPending: z.number().int().min(0).max(20), requests: z.number().int().min(0).max(2) }).strict().optional() }).strict() }).strict()).max(30),
  coverage: z.object({ page: z.number().int().positive(), nextPage: z.number().int().positive().nullable(), complete: z.boolean(), nextCursor: z.string().max(2000).nullable().optional() }).strict(),
}).strict();
export type MediaCreatorResult = z.infer<typeof mediaCreatorResult>;
const root = path.resolve(import.meta.dirname, "../../..");
export const mediaCreatorPlatforms = ["bilibili", "weibo", "xhs", "zhihu", "tieba", "douyin", "kuaishou"] as const;
const douyinPaths = ["/aweme/v1/web/user/profile/other/", "/aweme/v1/web/aweme/post/", "/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/"];
function zhihuPath(pathname: string, locator: string, contentId?: string, questionId?: string, searchTerm?: string) {
  if (/^\/api\/v4\/comment_v5\/comment\/\d{1,20}\/child_comment$/.test(pathname)) return !searchTerm || !!contentId;
  if (searchTerm && !contentId) return pathname === "/api/v4/search_v3";
  if (contentId) {
    const [kind, id] = contentId.split(":");
    return pathname === (kind === "article" ? `/p/${id}` : `/question/${questionId}/answer/${id}`)
      || pathname === `/api/v4/comment_v5/${kind}s/${id}/root_comment`;
  }
  return pathname === `/people/${locator}` || pathname === `/api/v4/members/${locator}/answers` || pathname === `/api/v4/members/${locator}/articles`
    || /^\/api\/v4\/comment_v5\/(answers|articles)\/\d+\/root_comment$/.test(pathname);
}
const zhihuSearchQuery = (url: URL, keyword?: string, contentId?: string) => !keyword || !!contentId
  || url.searchParams.get("q") === keyword && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "15";
/** Trusted fixed upstream code, not an untrusted-code sandbox. Each load owns a VM. */
async function fixedSignature(source: string, options: { platform: "zhihu" | "douyin"; digest: string; globals: Record<string, unknown>; expression: string }) {
  const script = (await readFile(path.join(source, `libs/${options.platform}.js`), "utf8")).replaceAll("\r\n", "\n");
  if (sha256(script) !== options.digest) throw new Error("采集签名源码不匹配，请重新准备固定运行环境");
  const context = createContext(options.globals);
  new Script(script).runInContext(context, { timeout: 1000 });
  const invoke = new Script(options.expression);
  return (values: Record<string, unknown>) => { Object.assign(context, values); return invoke.runInContext(context, { timeout: 1000 }); };
}
let active = false;
export class RepresentativeUnavailable extends Error {
  constructor() { super("本次单页搜索未取得可读取的候选作品，线索保留待核实"); }
}
export class MediaCrawlerFailure extends Error {
  readonly code: "login_required" | "rate_limited" | "platform_failed";
  constructor(code: "login_required" | "rate_limited" | "platform_failed") {
    super("平台读取未完成，请检查会话、验证要求和限流状态");
    this.code = code;
  }
}

/** Fixed upstream clients, real Python process, requests exclusively through guardedFetch.
 * Unconnected platform adapters remain explicit unfinished work, never successful empty collections. */
export async function collectMediaCreator(input: { platform: string; locator: string; page?: number; cookie?: string; cursor?: string; context?: Record<string, string>; videoId?: string; discover?: boolean; searchTerm?: string; metadataOnly?:boolean; metadataLimit?:number; onlyIds?:string[] }, options: { signal?: AbortSignal } = {}): Promise<MediaCreatorResult> {
  const job = z.object({ platform: z.enum(mediaCreatorPlatforms), locator: z.string().max(200), page: z.number().int().min(1).max(10000).default(1), cursor: z.string().max(2000).default(""),
    context: z.object({ xsec_token: z.string().max(2000).optional(), xsec_source: z.string().max(200).optional(), questionId: z.string().regex(/^\d{1,20}$/).optional() }).strict().default({}),
    cookie: z.string().max(16000).regex(/^[^\r\n]*$/).default(""), videoId: z.string().max(100).optional(), onlyIds:z.array(z.string().min(1).max(200)).min(1).max(30).optional(),metadataOnly:z.boolean().default(false),metadataLimit:z.number().int().min(1).max(30).default(5), discover: z.boolean().default(false), searchTerm: z.string().trim().min(1).max(500).optional() }).strict()
    .refine(value => !value.searchTerm || ["weibo", "douyin", "kuaishou", "zhihu", "tieba"].includes(value.platform) && value.discover && !value.videoId, "代表作品搜索暂未接入此平台")
    .refine(value => !value.discover || ["bilibili", "weibo", "xhs", "douyin", "kuaishou", "zhihu", "tieba"].includes(value.platform) && (!!value.videoId || !!value.searchTerm), "单作品发现暂未接入此平台")
    .refine(value => value.videoId === undefined || (value.platform === "bilibili" ? /^BV[A-Za-z0-9]{6,20}$/.test(value.videoId)
      : value.platform === "weibo" || value.platform === "douyin" || value.platform === "tieba" ? /^\d{1,20}$/.test(value.videoId)
      : value.platform === "kuaishou" ? /^[a-zA-Z0-9_-]{1,100}$/.test(value.videoId)
      : value.platform === "zhihu" ? /^(answer|article):\d{1,20}$/.test(value.videoId) && (value.videoId.startsWith("article:") || !!value.context.questionId)
      : value.platform === "xhs" && /^[a-f0-9]{24}$/i.test(value.videoId) && !!value.context.xsec_token), "指定视频媒体标识或平台无效").parse(input);
  if (job.platform === "xhs" && job.videoId) job.context.xsec_source ??= "pc_feed";
  if (job.platform === "tieba") z.string().regex(/^tb\.[A-Za-z0-9_.-]{1,197}$/).parse(job.locator);
  else if (job.platform === "xhs") z.string().regex(/^[a-f0-9]{24}$/i).parse(job.locator);
  else if (["zhihu", "douyin", "kuaishou"].includes(job.platform)) z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).parse(job.locator);
  else z.string().regex(/^\d{1,20}$/).parse(job.locator);
  const douyinToken = job.cookie.split(";").map(part => part.trim()).find(part => part.startsWith("msToken="))?.slice(8) ?? "";
  if (job.platform === "douyin" && !douyinToken) throw new MediaCrawlerFailure("login_required");
  const python = path.resolve(root, process.env.STUDIO_MEDIACRAWLER_PYTHON || "runtime/mediacrawler-env/Scripts/python.exe");
  const source = path.resolve(root, process.env.STUDIO_MEDIACRAWLER_SOURCE || "runtime/mediacrawler-source");
  try { await access(python); await access(path.join(source, "media_platform/bilibili/client.py")); }
  catch { throw new Error("MediaCrawler运行环境未安装，请先准备固定版本Python和采集依赖"); }
  const version = JSON.parse(await readFile(path.join(import.meta.dirname, "../vendor/mediacrawler/runtime.json"), "utf8")) as { commit: string; lockSha256: string; zhihuSignSha256: string; douyinSignSha256: string; kuaishouHelpSha256: string };
  const revision = await promisify(execFile)("git", ["-C", source, "rev-parse", "HEAD"], { windowsHide: true, timeout: 5000, env: localProcessEnvironment() });
  // Git on Windows may check out CRLF; compare the same UTF-8/LF lock on every host.
  const lock = (await readFile(path.join(source, "uv.lock"), "utf8")).replaceAll("\r\n", "\n");
  if (revision.stdout.trim() !== version.commit || sha256(lock) !== version.lockSha256) throw new Error("MediaCrawler源码或依赖锁版本不匹配，请重新准备固定运行环境");
  let sign: ((uri: string) => unknown) | undefined;
  if (job.platform === "zhihu") {
    const invoke = await fixedSignature(source, { platform: "zhihu", digest: version.zhihuSignSha256, expression: "get_sign(uri, cookie)",
      globals: { require(name: string) { if (name === "crypto") return { createHash }; throw new Error("不支持的签名依赖"); }, cookie: job.cookie, uri: "" } });
    sign = uri => invoke({ uri });
  }
  let douyinSign: ((params: string, agent: string, name: "sign_datail" | "sign_reply") => unknown) | undefined;
  if (job.platform === "douyin") {
    const invoke = await fixedSignature(source, { platform: "douyin", digest: version.douyinSignSha256,
      expression: "signKind === 'sign_reply' ? sign_reply(params, agent) : sign_datail(params, agent)", globals: { params: "", agent: "", signKind: "sign_datail" } });
    douyinSign = (params, agent, name) => invoke({ params, agent, signKind: name });
  }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(job.metadataOnly || job.onlyIds ? 240_000 : 90_000)]) : AbortSignal.timeout(job.metadataOnly || job.onlyIds ? 240_000 : 90_000);
  signal.throwIfAborted();
  if (active) throw new Error("已有博主采集正在运行，请稍后重试");
  active = true;
  try {
    const runChild = (page?: Page, childSignal = signal) => new Promise<MediaCreatorResult>((resolve, reject) => {
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([childSignal, controller.signal]);
      const child = spawn(python, ["-I", "-B", "-u", "-X", "utf8", path.join(import.meta.dirname, "mediacrawler-child.py"), source],
        { cwd: root, env: { ...localProcessEnvironment(), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let result: MediaCreatorResult | undefined, error: Error | undefined;
      const protocolBudget=job.onlyIds ? 120 : 80;
      let buffer = "", bytes = 0, pending = false, requests = 0;
      const finish = (cause: Error) => { error ??= cause; controller.abort(cause); child.kill(); };
      const subscription = addAbortListener(childSignal, () => finish(new Error("博主采集已取消或超时")));
      child.stdin.on("error", () => finish(new Error("采集进程通信中断")));
      child.stdin.write(JSON.stringify(job) + "\n");
      child.stdout.setEncoding("utf8");
      const receive = async (line: string) => {
        try {
          const raw: unknown = JSON.parse(line);
          const tag = z.object({ type: z.string() }).passthrough().parse(raw).type;
          if (tag === "content-selected") {
            if (!["weibo", "douyin", "kuaishou", "zhihu", "tieba"].includes(job.platform) || !job.searchTerm || job.videoId || pending || result) throw new Error("代表作品选择协议无效");
            const selected = z.object({ type: z.literal("content-selected"), externalId: z.string().regex(job.platform === "kuaishou" ? /^[A-Za-z0-9_-]{1,100}$/ : job.platform === "zhihu" ? /^(answer|article):\d{1,20}$/ : /^\d{1,20}$/),
              questionId: z.string().regex(/^\d{1,20}$/).optional() }).strict().parse(raw);
            if (job.platform === "zhihu" && selected.externalId.startsWith("answer:") && !selected.questionId || job.platform !== "zhihu" && selected.questionId) throw new Error("代表回答缺少所属问题或来源不匹配");
            if (selected.questionId) job.context.questionId = selected.questionId;
            job.videoId = selected.externalId;
            if (!child.killed) child.stdin.write(JSON.stringify({ ok: true }) + "\n");
          } else if (tag === "douyin-sign") {
            if (!douyinSign || pending || result || ++requests > protocolBudget) throw new Error("抖音签名协议无效");
            const message = z.object({ type: z.literal("douyin-sign"), name: z.enum(["sign_datail", "sign_reply"]).default("sign_datail"), params: z.string().max(16000), agent: z.string().max(1000) }).strict().parse(raw);
            const signed = z.string().min(10).max(8000).parse(douyinSign(message.params, message.agent, message.name));
            if (!child.killed) child.stdin.write(JSON.stringify(signed) + "\n");
          } else if (tag === "browser") {
            if (!page || !["tieba", "douyin", "kuaishou"].includes(job.platform) || pending || result || ++requests > protocolBudget) throw new Error("采集页面协议无效");
            const message = z.discriminatedUnion("action", [
              z.object({ type: z.literal("browser"), action: z.literal("goto"), url: z.literal("https://tieba.baidu.com") }).strict(),
              z.object({ type: z.literal("browser"), action: z.literal("state"), field: z.enum(["storage", "userAgent"]) }).strict(),
              z.object({ type: z.literal("browser"), action: z.literal("kuaishou-ready"), timeout: z.union([z.literal(15000), z.literal(20000)]) }).strict(),
              z.object({ type: z.literal("browser"), action: z.literal("kuaishou-reload") }).strict(),
              z.object({ type: z.literal("browser"), action: z.literal("kuaishou-sign"),
                uri: z.literal(job.searchTerm && !job.videoId ? "/rest/v/search/feed" : "/rest/v/profile/feed"),
                body: job.searchTerm && !job.videoId
                  ? z.object({ keyword: z.literal(job.searchTerm), pcursor: z.literal(""), page: z.literal("search"), searchSessionId: z.literal("") }).strict()
                  : z.object({ user_id: z.literal(job.locator), pcursor: z.literal(job.cursor), page: z.literal("profile") }).strict() }).strict(),
              z.object({ type: z.literal("browser"), action: z.literal("evaluate"), expression: z.string().max(16000),
                argument: z.object({ url: z.url().max(8000), method: z.enum(["GET", "POST"]), body: z.string().max(1000000) }).strict() }).strict(),
            ]).parse(raw);
            pending = true;
            try {
              let value: unknown;
              if (message.action === "kuaishou-ready" || message.action === "kuaishou-reload" || message.action === "kuaishou-sign") {
                if (job.platform !== "kuaishou") throw new Error("快手页面签名未接入");
                if (message.action === "kuaishou-ready") {
                  try { const handle = await page.waitForFunction("Boolean(window.__ks_realm)", undefined, { timeout: message.timeout }); await handle.dispose(); value = true; }
                  catch (cause) { if (cause instanceof Error && cause.name === "TimeoutError" && !requestSignal.aborted) value = false; else throw cause; }
                }
                else if (message.action === "kuaishou-reload") { await page.reload({ waitUntil: "domcontentloaded" }); value = null; }
                else value = z.string().min(1).max(8000).parse(await page.evaluate(`(body => new Promise((resolve, reject) => {
                  window.__ks_realm.call('$encode', [
                    { url: ${JSON.stringify(message.uri)}, query: { caver: 2 }, form: {}, requestBody: body },
                    { suc: s => resolve(s), err: e => reject(new Error(String(e))) }
                  ]);
                }))(${JSON.stringify(message.body)})`));
              } else if (message.action === "state") {
                if (job.platform !== "douyin" && !(job.platform === "kuaishou" && message.field === "userAgent")) throw new Error("采集页面状态未接入");
                value = await page.evaluate(message.field === "storage" ? "Object.fromEntries(Object.entries(window.localStorage))" : "navigator.userAgent");
              } else if (message.action === "goto") {
                if (job.platform !== "tieba") throw new Error("采集页面导航未接入");
                await page.goto(message.url, { waitUntil: "domcontentloaded" }); value = null;
              }
              else {
                if (job.platform !== "tieba") throw new Error("采集页面脚本未接入");
                const target = new URL(message.argument.url);
                if (target.origin !== "https://tieba.baidu.com" || target.username || target.password) throw new Error("采集页面目标未接入");
                const replyPage = target.pathname === "/p/comment" && message.argument.method === "GET" && !message.argument.body
                  && target.searchParams.get("pn") === "1" && [...target.searchParams].length === 4
                  && ["tid", "pid", "fid"].every(key => /^\d{1,20}$/.test(target.searchParams.get(key) ?? ""));
                if (target.pathname === "/p/comment" && !replyPage) throw new Error("楼中楼只读取当前回帖第一页");
                if (job.searchTerm && !job.videoId && !(message.argument.method === "GET" && !message.argument.body && target.pathname === "/mo/q/search/multsearch"
                  && target.searchParams.get("word") === job.searchTerm && target.searchParams.get("pn") === "1" && target.searchParams.get("rn") === "20"))
                  throw new Error("帖子搜索只读取当前关键词第一页");
                if (job.videoId) {
                  const body = new URLSearchParams(message.argument.body);
                  if (!(message.argument.method === "GET" && target.pathname === "/c/s/pc/sync"
                    || replyPage && target.searchParams.get("tid") === job.videoId
                    || message.argument.method === "POST" && target.pathname === "/c/f/pb/page_pc" && body.get("kz") === job.videoId && body.get("pn") === "1"))
                    throw new Error("指定帖子读取不允许扫描主页或其他帖子");
                }
                // Python auto-invokes function strings; Node treats a string as an expression.
                value = await page.evaluate(`(${message.expression})(${JSON.stringify(message.argument)})`);
              }
              const reply = JSON.stringify({ value, url: page.url() });
              if (Buffer.byteLength(reply) > 8 * 1024 * 1024) throw new Error("采集页面结果超过限制");
              if (!child.killed) child.stdin.write(reply + "\n");
            } finally { pending = false; }
          } else if (tag === "zhihu-sign") {
            if (!sign || pending || result || ++requests > protocolBudget) throw new Error("采集签名协议无效");
            const message = z.object({ type: z.literal("zhihu-sign"), uri: z.string().max(8000) }).strict().parse(raw);
            const target = new URL(message.uri, "https://www.zhihu.com");
            if (!message.uri.startsWith("/") || target.origin !== "https://www.zhihu.com" || !zhihuPath(target.pathname, job.locator, job.videoId, job.context.questionId, job.searchTerm)
              || !zhihuSearchQuery(target, job.searchTerm, job.videoId) || target.hash) throw new Error("签名目标未接入");
            const signed = z.object({ "x-zst-81": z.string().max(4000), "x-zse-96": z.string().max(4000) }).strict().parse(sign(message.uri));
            if (!child.killed) child.stdin.write(JSON.stringify(signed) + "\n");
          } else if (tag === "fetch") {
            if (pending || result || ++requests > protocolBudget) throw new Error("采集请求协议无效");
            const request = z.object({ type: z.literal("fetch"), url: z.url().max(8000), method: z.enum(["GET", "POST"]),
              headers: z.record(z.string(), z.string()), body: z.string().max(1400000) }).strict().parse(raw);
            const url = new URL(request.url);
            const allowed = job.platform === "bilibili"
              ? request.method === "GET" && url.origin === "https://api.bilibili.com" && (/^\/x\/(web-interface\/nav|space\/wbi\/(acc\/info|arc\/search)|v2\/reply\/(wbi\/main|reply))$/.test(url.pathname)
                || !!job.videoId && ["/x/web-interface/view/detail", "/x/player/wbi/playurl", "/x/player/wbi/v2"].includes(url.pathname))
              : job.platform === "weibo" ? request.method === "GET" && url.origin === "https://m.weibo.cn" && (job.searchTerm && !job.videoId
                ? url.pathname === "/api/container/getIndex" && url.searchParams.get("containerid") === `100103type=1&q=${job.searchTerm}`
                  && url.searchParams.get("page_type") === "searchall" && url.searchParams.get("page") === "1" && [...url.searchParams].length === 3
                : job.videoId ? url.pathname === `/detail/${job.videoId}`
                : /^\/api\/container\/getIndex$/.test(url.pathname) || /^\/comments\/hotflow$/.test(url.pathname) || /^\/detail\/\d+$/.test(url.pathname))
              : job.platform === "zhihu" ? request.method === "GET" && url.origin === (url.pathname.startsWith("/p/") ? "https://zhuanlan.zhihu.com" : "https://www.zhihu.com")
                && zhihuPath(url.pathname, job.locator, job.videoId, job.context.questionId, job.searchTerm) && zhihuSearchQuery(url, job.searchTerm, job.videoId)
              : job.platform === "douyin" ? request.method === "GET" && url.origin === "https://www.douyin.com" && (job.searchTerm && !job.videoId
                ? url.pathname === "/aweme/v1/web/general/search/single/" && url.searchParams.get("keyword") === job.searchTerm
                  && url.searchParams.get("offset") === "0" && url.searchParams.get("count") === "15" && url.searchParams.get("search_channel") === "aweme_general"
                : job.videoId
                ? url.pathname === "/aweme/v1/web/aweme/detail/" && url.searchParams.get("aweme_id") === job.videoId : douyinPaths.includes(url.pathname))
              : job.platform === "kuaishou" ? request.method === "POST" && url.origin === "https://www.kuaishou.com" && (job.searchTerm && !job.videoId
                ? url.pathname === "/rest/v/search/feed" && url.searchParams.get("caver") === "2" && !!url.searchParams.get("__NS_hxfalcon") && [...url.searchParams].length === 2
                : job.videoId
                ? url.pathname === "/graphql" : ["/graphql", "/rest/v/profile/feed", "/rest/v/photo/comment/list", "/rest/v/photo/comment/sublist"].includes(url.pathname))
              : job.platform === "xhs" && (job.videoId ? request.method === "POST" && url.origin === "https://edith.xiaohongshu.com" && url.pathname === "/api/sns/web/v1/feed"
                : (request.method === "GET" && url.origin === "https://www.xiaohongshu.com" && url.pathname === `/user/profile/${job.locator}`)
                || (url.origin === "https://edith.xiaohongshu.com" && (request.method === "GET" && /^\/api\/sns\/web\/(v1\/user_posted|v2\/comment\/(sub\/)?page)$/.test(url.pathname)
                  || request.method === "POST" && url.pathname === "/api/sns/web/v1/feed")));
            if (!allowed) throw new Error("采集目标不在已接入接口内");
            const body = Buffer.from(request.body, "base64");
            if (body.length > 1024 * 1024 || body.toString("base64") !== request.body || request.method === "GET" && body.length) throw new Error("采集请求体无效或超过限制");
            if (job.platform === "kuaishou" && job.searchTerm && !job.videoId) {
              z.object({ keyword: z.literal(job.searchTerm), pcursor: z.literal(""), page: z.literal("search"), searchSessionId: z.literal("") }).strict().parse(JSON.parse(body.toString("utf8")));
            }
            if (job.platform === "xhs" && job.videoId) {
              z.object({ source_note_id: z.literal(job.videoId), xsec_token: z.literal(job.context.xsec_token!), xsec_source: z.literal(job.context.xsec_source || "pc_search"),
                image_formats: z.tuple([z.literal("jpg"), z.literal("webp"), z.literal("avif")]), extra: z.object({ need_body_topic: z.literal(1) }).strict() }).strict().parse(JSON.parse(body.toString("utf8")));
            }
            if (job.platform === "kuaishou" && url.pathname === "/graphql") {
              const schema = job.videoId
                ? z.object({ operationName: z.literal("visionVideoDetail"), variables: z.object({ photoId: z.literal(job.videoId), page: z.literal("search") }).strict(),
                  query: z.string().max(10000).refine(value => /^\s*query\s+visionVideoDetail\(/.test(value) && !/\bmutation\b/i.test(value)) }).strict()
                : z.object({ operationName: z.literal("visionProfile"), variables: z.object({ userId: z.literal(job.locator) }).strict(),
                  query: z.string().max(10000).refine(value => /^\s*query\s+visionProfile\(/.test(value) && !/\bmutation\b/i.test(value)) }).strict();
              schema.parse(JSON.parse(body.toString("utf8")));
            }
            pending = true;
            try {
              const response = await guardedFetch(request.url, { method: request.method, headers: request.headers, body: body.length ? body : undefined, route: "direct", redirect: "error",
                timeoutMs: 10000, maxBytes: 4 * 1024 * 1024, signal: requestSignal });
              const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
              if (!child.killed) child.stdin.write(JSON.stringify({ status: response.status, headers: Object.fromEntries(headers), body: response.body.toString("base64") }) + "\n");
            } catch { finish(new Error("平台请求失败，请检查网络、登录状态或限流后重试")); }
            finally { pending = false; }
          } else if (tag === "result") {
            if (pending || result) throw new Error("采集结果尚未完整");
            result = mediaCreatorResult.parse(z.object({ type: z.literal("result"), result: z.unknown() }).strict().parse(raw).result);
          } else if (tag === "error") {
            const failure = z.object({ type: z.literal("error"), code: z.enum(["login_required", "rate_limited", "platform_failed", "no_representative"]) }).strict().parse(raw);
            if (failure.code === "no_representative") throw new RepresentativeUnavailable();
            throw new MediaCrawlerFailure(failure.code);
          } else throw new Error("平台读取失败，请检查会话、验证要求和限流状态");
        } catch (cause) { finish(cause instanceof MediaCrawlerFailure || cause instanceof RepresentativeUnavailable ? cause : new Error("采集失败：平台返回格式不兼容或请求未完整完成")); }
      };
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > 32 * 1024 * 1024 || buffer.length > 8 * 1024 * 1024) { finish(new Error("采集结果超过限制")); return; }
        let next: number;
        while ((next = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, next); buffer = buffer.slice(next + 1); void receive(line); }
      });
      child.once("error", () => finish(new Error("无法启动MediaCrawler运行环境")));
      child.once("close", code => {
        subscription[Symbol.dispose](); controller.abort();
        if (error) reject(error);
        else if (code !== 0 || !result || pending || buffer.trim()) reject(new Error("采集进程未完整完成"));
        else resolve(result);
      });
    });
    if (job.platform !== "tieba" && job.platform !== "douyin" && job.platform !== "kuaishou") return await runChild();
    let childFailure: unknown, running: Promise<MediaCreatorResult> | undefined;
    const browserController = new AbortController(), browserSignal = AbortSignal.any([signal, browserController.signal]);
    try { return await withCollectorPage({ platform: job.platform, cookie: job.cookie, signal: browserSignal }, async page => {
      if (job.platform === "kuaishou") {
        const helper = (await readFile(path.join(source, "media_platform/kuaishou/help.py"), "utf8")).replaceAll("\r\n", "\n");
        if (sha256(helper) !== version.kuaishouHelpSha256) throw new Error("快手页面捕获源码不匹配，请重新准备固定运行环境");
        const capture = helper.match(/KS_SIGN_CAPTURE_SCRIPT = """([\s\S]*?)"""/);
        if (!capture) throw new Error("快手原页面捕获脚本缺失");
        await page.addInitScript(capture[1]);
        await page.goto("https://www.kuaishou.com/?isHome=1", { waitUntil: "domcontentloaded" });
      }
      if (job.platform === "douyin") {
        await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded" });
        // Seed only the supplied session token; never claim to have acquired page SDK state.
        await page.evaluate(`localStorage.setItem("xmst", ${JSON.stringify(douyinToken)})`);
      }
      try { running = runChild(page, browserSignal); return await running; } catch (error) { childFailure = error; throw error; }
    }); } catch (error) { throw childFailure ?? error; }
    finally { browserController.abort(); await running?.catch(() => {}); }
  } finally { active = false; }
}
