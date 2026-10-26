import { z } from "zod";
import { modelBudgetLimits, saveModelBudgetLimits, BudgetLimitsConflict } from "@aihot/backend/providers/llm-budget";
import { audit, Conflict } from "@aihot/backend/audit";
import type { ModelBudgetSettings } from "../contracts.ts";

export function modelBudgetSettings(): ModelBudgetSettings {
  return { ...modelBudgetLimits(), currency: "CNY", timeZone: "Asia/Hong_Kong" };
}
export async function saveModelBudgetSettings(input: unknown, actor: string) {
  const limit = z.number().min(0).max(1_000_000);
  const value = z.object({ version: z.number().int().nonnegative(), perDay: limit, perMonth: limit,
    hardLimitEnabled: z.boolean().optional(), warningPerDay: limit.optional(), warningPerMonth: limit.optional() }).strict().parse(input);
  const before = modelBudgetSettings();
  try {
    const saved = saveModelBudgetLimits(value, actor);
    await audit(actor, "studio.model.budget", "studio.model.budget", null, before, saved);
    return { ...saved, currency: "CNY", timeZone: "Asia/Hong_Kong" } satisfies ModelBudgetSettings;
  } catch (error) { if (error instanceof BudgetLimitsConflict) throw new Conflict(error.message); throw error; }
}
