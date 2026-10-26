// DeepSeek currency budget guard for the LLM path (minimal, additive adaptation).
//
// The stock receipts/budgets only limit *request counts* for paid collectors; the LLM steps
// have no currency cap. This adds a shared, persistent ledger with per-call worst-case
// reservation so every process shares accounting and explicitly enabled CNY caps.
//
// - Reserve a worst-case cost BEFORE the call; enforce caps only when explicitly enabled.
// - Fresh installations warn at 10/day and 200/month; existing explicit caps stay enabled.
// - Settle against the real token usage AFTER the call; keep the reservation if the outcome
//   is unknown (conservative).
// - State is appended to a JSONL ledger under the data dir, so restarts never reset it and a
//   file lock serializes concurrent processes.
//
// Prices (CNY per 1M tokens, DeepSeek Flash, 2026-10): idle 1 / 0.02 / 4 (input-miss,
// input-hit, output); peak (weekdays 09:00-12:00, 14:00-18:00 Asia/Shanghai) doubles them.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";

const DIR = join(config.dataDir, "llm-budget");
const LEDGER = join(DIR, "ledger.jsonl");
const LOCK = join(DIR, "ledger.lock");
const LIMITS = join(DIR, "limits.json");

const num = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
const PER_DAY = num("LLM_BUDGET_CNY_PER_DAY", 10);
const PER_MONTH = num("LLM_BUDGET_CNY_PER_MONTH", 200);
// Existing explicit environment caps stay enforced; a fresh installation only warns.
const HARD_LIMIT_ENABLED = process.env.LLM_BUDGET_CNY_PER_DAY !== undefined || process.env.LLM_BUDGET_CNY_PER_MONTH !== undefined;
const TOKENS_PER_CHAR = num("LLM_TOKEN_PER_CHAR", 1.0); // conservative estimate; chars are not tokens
const LOCK_TRIES = 200, LOCK_WAIT_MS = 25;

function ensureDir() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

function acquireLock(): number {
  ensureDir();
  for (let i = 0; i < LOCK_TRIES; i++) {
    try { return openSync(LOCK, "wx"); }
    catch (e) { if ((e as { code?: string }).code !== "EEXIST") throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS); }
  }
  throw new Error("llm-budget: could not acquire ledger lock");
}
function releaseLock(fd: number) { closeSync(fd); try { unlinkSync(LOCK); } catch {} }

export interface ModelBudgetLimits { version: number; perDay: number; perMonth: number; updatedAt: string | null;
  hardLimitEnabled: boolean; warningPerDay: number; warningPerMonth: number }
/** A brief shared-lock capture, after the DB snapshot. Never resets or settles any reservation. */
export function modelBudgetBackupFiles(): Record<string, Buffer> {
  const fd = acquireLock();
  try {
    const limits = modelBudgetLimits();
    const effective = { format: 2, ...limits, version: Math.max(1, limits.version), updatedAt: limits.updatedAt ?? new Date().toISOString(), updatedBy: "backup:effective-defaults" };
    return { "limits.json": existsSync(LIMITS) ? readFileSync(LIMITS) : Buffer.from(JSON.stringify(effective) + "\n"),
      "ledger.jsonl": existsSync(LEDGER) ? readFileSync(LEDGER) : Buffer.alloc(0) };
  } finally { releaseLock(fd); }
}
export class BudgetLimitsConflict extends Error {}
const validLimit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

/** A missing override uses runtime defaults. Corrupt saved limits fail closed, never reset spending. */
export function modelBudgetLimits(): ModelBudgetLimits {
  let saved: string;
  try { saved = readFileSync(LIMITS, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 0, perDay: PER_DAY, perMonth: PER_MONTH, updatedAt: null,
      hardLimitEnabled: HARD_LIMIT_ENABLED, warningPerDay: 10, warningPerMonth: 200 };
    throw new Error("模型预算配置无法读取，请检查数据目录");
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(saved); } catch { throw new Error("模型预算配置损坏，未放行新的模型请求"); }
  if (!value || ![1, 2].includes(value.format as number) || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !validLimit(value.perDay) || !validLimit(value.perMonth) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))
    throw new Error("模型预算配置无效，未放行新的模型请求");
  if (value.format === 2 && (typeof value.hardLimitEnabled !== "boolean" || !validLimit(value.warningPerDay) || !validLimit(value.warningPerMonth)))
    throw new Error("模型预算配置无效，未放行新的模型请求");
  return { version: value.version as number, perDay: value.perDay, perMonth: value.perMonth, updatedAt: value.updatedAt,
    hardLimitEnabled: value.format === 1 ? true : value.hardLimitEnabled as boolean,
    warningPerDay: value.format === 1 ? 10 : value.warningPerDay as number, warningPerMonth: value.format === 1 ? 200 : value.warningPerMonth as number };
}

/** Same lock as reservations: the next process/attempt sees the new cap without a restart. */
export function saveModelBudgetLimits(input: Pick<ModelBudgetLimits, "version" | "perDay" | "perMonth"> & Partial<Pick<ModelBudgetLimits, "hardLimitEnabled" | "warningPerDay" | "warningPerMonth">>, actor: string): ModelBudgetLimits {
  if (!Number.isSafeInteger(input.version) || input.version < 0 || !validLimit(input.perDay) || !validLimit(input.perMonth)) throw new Error("模型预算上限无效");
  if (input.hardLimitEnabled !== undefined && typeof input.hardLimitEnabled !== "boolean"
    || input.warningPerDay !== undefined && !validLimit(input.warningPerDay) || input.warningPerMonth !== undefined && !validLimit(input.warningPerMonth)) throw new Error("模型预算设置无效");
  const fd = acquireLock(), temporary = join(DIR, `limits-${randomUUID()}.tmp`);
  let output: number | undefined;
  try {
    const before = modelBudgetLimits();
    if (before.version !== input.version) throw new BudgetLimitsConflict("模型预算已在其他窗口修改，请刷新后重试");
    const next = { format: 2, version: before.version + 1, perDay: input.perDay, perMonth: input.perMonth,
      hardLimitEnabled: input.hardLimitEnabled ?? true, warningPerDay: input.warningPerDay ?? before.warningPerDay,
      warningPerMonth: input.warningPerMonth ?? before.warningPerMonth, updatedAt: new Date().toISOString(), updatedBy: actor };
    output = openSync(temporary, "wx", 0o600); writeFileSync(output, JSON.stringify(next) + "\n"); fsyncSync(output); closeSync(output); output = undefined;
    renameSync(temporary, LIMITS);
    return { version: next.version, perDay: next.perDay, perMonth: next.perMonth, updatedAt: next.updatedAt,
      hardLimitEnabled: next.hardLimitEnabled, warningPerDay: next.warningPerDay, warningPerMonth: next.warningPerMonth };
  } finally { if (output !== undefined) closeSync(output); try { unlinkSync(temporary); } catch {} releaseLock(fd); }
}

/** Beijing (Asia/Shanghai, fixed +08) calendar parts of an instant. */
function beijing(d: Date) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const dow = t.getUTCDay(); // 0=Sun
  return { date: t.toISOString().slice(0, 10), month: t.toISOString().slice(0, 7), hour: t.getUTCHours(), weekday: dow >= 1 && dow <= 5 };
}
function isPeak(d: Date) {
  const { hour, weekday } = beijing(d);
  return weekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}
function pricePerMillion(d: Date) {
  const peak = isPeak(d);
  return { inMiss: peak ? 2 : 1, inHit: peak ? 0.04 : 0.02, out: peak ? 8 : 4 };
}
function costCny(tokensInMiss: number, tokensInHit: number, tokensOut: number, when: Date) {
  const p = pricePerMillion(when);
  return (tokensInMiss * p.inMiss + tokensInHit * p.inHit + tokensOut * p.out) / 1e6;
}

export interface ModelBudgetPrice { inputPerMillion: number; outputPerMillion: number }
interface Entry { id: string; kind: "reserve" | "settle" | "unknown"; ts: string; day: string; month: string; reservedCny: number; costCny?: number; purposes?: string; model?: string; subject?: string; price?: ModelBudgetPrice; usage?: { inHit: number; inMiss: number; out: number }; }

function readEntries(): Entry[] {
  if (!existsSync(LEDGER)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s) as Entry); } catch {}
  }
  return out;
}
/** Sum committed cost per id (settle/unknown wins over the reserve for that id). */
function currentEntries(entries: Entry[]) {
  const byId = new Map<string, Entry>();
  for (const e of entries) byId.set(e.id, { ...byId.get(e.id), ...e });
  return [...byId.values()];
}
function totals(entries: Entry[]) {
  let day = 0, month = 0; const dayKey = beijing(new Date()).date, monthKey = beijing(new Date()).month;
  for (const e of currentEntries(entries)) {
    const c = e.costCny ?? e.reservedCny ?? 0;
    if (e.month === monthKey) month += c;
    if (e.day === dayKey) day += c;
  }
  return { day, month };
}

export type Reservation = { ok: true; id: string } | { ok: false; reason: string };
function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reserve the worst-case cost of one call. Returns ok:false when a cap would be crossed. */
export function reserveBudget(opts: { purpose?: string; model: string; promptChars: number; maxTokens: number; subject?: string; price?: ModelBudgetPrice }): Reservation {
  const now = new Date();
  const be = beijing(now);
  const estIn = Math.ceil(Math.max(0, opts.promptChars) * TOKENS_PER_CHAR);
  if (opts.price && ![opts.price.inputPerMillion, opts.price.outputPerMillion].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Invalid model budget price");
  const worst = opts.price ? (estIn * opts.price.inputPerMillion + Math.max(0, opts.maxTokens) * opts.price.outputPerMillion) / 1e6
    : costCny(estIn, 0, Math.max(0, opts.maxTokens), now); // assume cache-miss input + full output
  ensureDir();
  const fd = acquireLock();
  try {
    const { day, month } = totals(readEntries());
    const limits = modelBudgetLimits();
    if (limits.hardLimitEnabled && day + worst > limits.perDay) return { ok: false, reason: `daily budget ${limits.perDay} CNY would be exceeded (used ${day.toFixed(4)}, need up to ${worst.toFixed(4)})` };
    if (limits.hardLimitEnabled && month + worst > limits.perMonth) return { ok: false, reason: `monthly budget ${limits.perMonth} CNY would be exceeded (used ${month.toFixed(4)}, need up to ${worst.toFixed(4)})` };
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: Entry = { id, kind: "reserve", ts: now.toISOString(), day: be.date, month: be.month, reservedCny: worst, purposes: opts.purpose, model: opts.model, subject: opts.subject, price: opts.price };
    appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
    return { ok: true, id };
  } finally { releaseLock(fd); }
}

/** Settle a reservation with the real usage from the provider response. */
export function settleBudget(id: string, usage: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } | null | undefined): void {
  const now = new Date(); const be = beijing(now);
  const fd = acquireLock();
  try {
    const entries = readEntries();
    const rsv = entries.find((e) => e.id === id && e.kind === "reserve");
    const reservedCny = rsv?.reservedCny ?? 0;
    let costCny_ = reservedCny;
    let usageOut: Entry["usage"];
    const inHit = usage?.prompt_cache_hit_tokens ?? 0;
    const inMiss = usage?.prompt_cache_miss_tokens ?? (usage?.prompt_tokens === undefined ? undefined : usage.prompt_tokens - inHit);
    const out = usage?.completion_tokens;
    if (tokenCount(inHit) && tokenCount(inMiss) && tokenCount(out)
      && (usage?.prompt_tokens === undefined || tokenCount(usage.prompt_tokens) && usage.prompt_tokens === inMiss + inHit)) {
      costCny_ = rsv?.price ? ((inMiss + inHit) * rsv.price.inputPerMillion + out * rsv.price.outputPerMillion) / 1e6 : costCny(inMiss, inHit, out, now);
      usageOut = { inHit, inMiss, out };
    }
    const entry: Entry = { id, kind: usageOut ? "settle" : "unknown", ts: now.toISOString(), day: be.date, month: be.month, reservedCny,
      ...(usageOut ? { costCny: costCny_, usage: usageOut } : {}), purposes: rsv?.purposes, model: rsv?.model, subject: rsv?.subject };
    appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  } finally { releaseLock(fd); }
}

/** Mark a call whose outcome is unknown; the worst-case reservation is retained. */
export function markBudgetUnknown(id: string): void {
  const now = new Date(); const be = beijing(now);
  const fd = acquireLock();
  try {
    const rsv = readEntries().find((e) => e.id === id && e.kind === "reserve");
    const entry: Entry = { id, kind: "unknown", ts: now.toISOString(), day: be.date, month: be.month, reservedCny: rsv?.reservedCny ?? 0, purposes: rsv?.purposes, model: rsv?.model, subject: rsv?.subject };
    appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  } finally { releaseLock(fd); }
}

/** Current committed spend (CNY) for reporting. */
export function budgetStatus() {
  return statusFor(readEntries());
}
function statusFor(entries: Entry[]) {
  const { day, month } = totals(entries);
  const { perDay, perMonth, hardLimitEnabled, warningPerDay, warningPerMonth } = modelBudgetLimits();
  return { perDay, perMonth, spentToday: day, spentThisMonth: month, remainingToday: perDay - day, remainingThisMonth: perMonth - month,
    hardLimitEnabled, warningPerDay, warningPerMonth, warningToday: day >= warningPerDay, warningThisMonth: month >= warningPerMonth };
}

/** Read the same reservation ledger as enforcement; no keys, subjects or source text leave it. */
export function modelBudgetReport() {
  const entries = readEntries(), calendar = beijing(new Date());
  const purposes = new Map<string, { purpose: string; estimatedToday: number; estimatedThisMonth: number; reservedToday: number; reservedThisMonth: number }>();
  for (const entry of currentEntries(entries)) {
    if (entry.month !== calendar.month) continue;
    const purpose = entry.purposes ?? "";
    const row = purposes.get(purpose) ?? { purpose, estimatedToday: 0, estimatedThisMonth: 0, reservedToday: 0, reservedThisMonth: 0 };
    const cost = entry.costCny ?? entry.reservedCny ?? 0;
    if (entry.kind === "settle") { row.estimatedThisMonth += cost; if (entry.day === calendar.date) row.estimatedToday += cost; }
    else { row.reservedThisMonth += cost; if (entry.day === calendar.date) row.reservedToday += cost; }
    purposes.set(purpose, row);
  }
  return { day: calendar.date, month: calendar.month, budget: statusFor(entries), purposes: [...purposes.values()] };
}
