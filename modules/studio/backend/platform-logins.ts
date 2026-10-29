import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Conflict } from "@aihot/backend/audit";
import { claimExecutionLease, releaseExecutionLease } from "@aihot/backend/jobs/execution-lease";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { savePlatformSession } from "./platform-sessions.ts";
import { scheduleCreators } from "./creator-collection.ts";
import type { CreatorPlatform } from "../contracts.ts";

const platform = z.enum(["xhs", "douyin", "kuaishou", "bilibili", "weibo", "tieba", "zhihu"]);
export const loginAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).max(899), y: z.number().min(0).max(649) }).strict(),
  z.object({ type: z.literal("drag"), x: z.number().min(0).max(899), y: z.number().min(0).max(649), toX: z.number().min(0).max(899), toY: z.number().min(0).max(649) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "ControlOrMeta+A"]) }).strict(),
  z.object({ type: z.literal("scroll"), delta: z.number().min(-650).max(650) }).strict(),
]);
export type LoginAction = z.infer<typeof loginAction>;
export type LoginBrowser = { frame(): Promise<Buffer>; session(): Promise<string>; action(value: LoginAction): Promise<void>; close(): Promise<void> };
export type LoginBrowserFactory = (platform: CreatorPlatform, signal: AbortSignal) => Promise<LoginBrowser>;
export class LoginBrowserOpenFailed extends Error {
  readonly cleanupConfirmed: boolean;
  constructor(cleanupConfirmed: boolean, reason: "timeout"|"network"|"component"="component") { super(reason==="timeout" ? "平台页面加载超时，请稍后重试或手动保存Cookie" : reason==="network" ? "服务器暂时无法连接平台登录页，请稍后重试或手动保存Cookie" : "平台登录页面未能打开，请检查浏览器组件和平台网络"); this.cleanupConfirmed = cleanupConfirmed; }
}
type State = "waiting" | "saved" | "cancelled" | "expired" | "failed" | "conflict";
type Login = { id: string; platform: CreatorPlatform; version: number; actor: string; state: State; expiresAt: number; browser: LoginBrowser;
  controller: AbortController; collection: "paused" | "scheduled" | "pending"; timer?: ReturnType<typeof setTimeout>; operation: Promise<unknown>; closing?: Promise<void> };
const group = "studio-creator-media", duration = 4 * 60_000;

/** One ephemeral remote page; only the encrypted platform session survives completion. */
export function createPlatformLogins(options: { browser: LoginBrowserFactory; canStart(): boolean }) {
  const sessions = new Map<string, Login>();
  let opening = false, stopped = false;
  let openingFinished: Promise<void> = Promise.resolve(), resolveOpening: (() => void) | undefined;
  const view = (s: Login) => ({ id: s.id, platform: s.platform, state: s.state, expiresAt: new Date(s.expiresAt).toISOString(), collection: s.collection });
  const get = (id: string) => { const s = sessions.get(id); if (!s) throw new Conflict("登录窗口已失效，请重新打开"); return s; };
  const finish = (s: Login, state: State) => s.closing ??= (async () => {
    clearTimeout(s.timer); s.controller.abort();
    try { await s.browser.close(); await releaseExecutionLease(group, s.id); }
    finally { s.state = state; }
  })();
  const serial = <T>(s: Login, run: () => Promise<T>) => {
    const task = s.operation.then(run); s.operation = task.catch(() => {}); return task;
  };
  const poll = (s: Login) => {
    s.timer = setTimeout(() => { void serial(s, async () => {
      if (s.state !== "waiting") return;
      if (Date.now() >= s.expiresAt) { await finish(s, "expired"); return; }
      try {
        const cookie = await s.browser.session();
        if(s.controller.signal.aborted || s.state !== "waiting") return;
        if (cookie) {
          await savePlatformSession(s.platform, { version: s.version, cookie }, s.actor);
          await finish(s, "saved");
          if (collectionEnabled()) {
            try { await scheduleCreators(); s.collection = "scheduled"; } catch { s.collection = "pending"; }
          }
          return;
        }
      } catch (error) { await finish(s, (error as { code?: string }).code === "conflict" ? "conflict" : "failed"); return; }
      poll(s);
    }).catch(() => {}); }, 1000);
    s.timer.unref();
  };
  return {
    async start(value: unknown, actor: string) {
      const input = z.object({ platform, version: z.number().int().nonnegative() }).strict().parse(value);
      const existing=[...sessions.values()].find(s=>s.platform===input.platform && s.state==="waiting" && !s.controller.signal.aborted);
      if(existing) return view(existing);
      if (stopped || opening || [...sessions.values()].some(s => s.state === "waiting" || !!s.closing && !s.controller.signal.aborted)) throw new Conflict("已有登录窗口正在使用，请先关闭或完成登录");
      if (!options.canStart()) throw new Conflict("资源正在恢复或繁忙，请稍后再打开登录窗口");
      opening = true;
      openingFinished = new Promise<void>(resolve => { resolveOpening = resolve; });
      const id = randomUUID(), controller = new AbortController();
      let claimed = false;
      let browser: LoginBrowser | undefined, cleanupConfirmed = false;
      try {
        claimed = await claimExecutionLease(group, id, 330);
        if (!claimed) throw new Conflict("采集或转写正在使用浏览器执行位，请稍后再试");
        const expiresAt = Date.now() + duration;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(duration)]);
        browser = await options.browser(input.platform, signal);
        if (stopped || signal.aborted) { await browser.close(); cleanupConfirmed = true; throw new Conflict("登录窗口已关闭或超时，请重试"); }
        for (const [key, s] of sessions) if (s.state !== "waiting") sessions.delete(key);
        const s: Login = { ...input, id, actor, browser, controller, expiresAt, state: "waiting", collection: "paused", operation: Promise.resolve() };
        sessions.set(id, s); poll(s); return view(s);
      } catch (error) {
        controller.abort();
        if (browser && !cleanupConfirmed) { try { await browser.close(); cleanupConfirmed = true; } catch {} }
        if (claimed && (cleanupConfirmed || error instanceof LoginBrowserOpenFailed && error.cleanupConfirmed)) await releaseExecutionLease(group, id);
        if (error instanceof Conflict) throw error;
        if(error instanceof LoginBrowserOpenFailed) throw new Conflict(error.message);
        throw new Conflict("登录窗口未能打开，请检查采集组件与平台网络后重试");
      } finally { opening = false; resolveOpening?.(); }
    },
    status(id: string) { return view(get(id)); },
    async frame(id: string) { const s = get(id); return serial(s, async () => {
      if (s.state !== "waiting" || Date.now() >= s.expiresAt) throw new Conflict("登录窗口已结束，请重新打开");
      try { const body = await s.browser.frame(); if (body.length > 2 * 1024 ** 2) throw new Error(); return body; }
      catch { throw new Conflict("登录画面暂时不可用，请稍后刷新或重新打开"); }
    }); },
    async action(id: string, value: unknown) { const input = loginAction.parse(value), s = get(id); return serial(s, async () => {
      if (s.state !== "waiting" || Date.now() >= s.expiresAt) throw new Conflict("登录窗口已结束，请重新打开");
      try { await s.browser.action(input); } catch { throw new Conflict("本次登录操作未完成，请重试"); }
      return view(s);
    }); },
    async cancel(id: string) { const s = get(id); if(s.state === "waiting") { s.controller.abort(); await serial(s,()=>s.state==="waiting" ? finish(s,"cancelled") : Promise.resolve()); } return view(s); },
    async close() { stopped = true; await openingFinished; await Promise.all([...sessions.values()].map(s => serial(s, () => s.state === "waiting" ? finish(s, "cancelled") : Promise.resolve()))); },
  };
}
