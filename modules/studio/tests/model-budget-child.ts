import "../../../tests/setup.ts";
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { budgetStatus } from "@aihot/backend/providers/llm-budget";
import { closeDb } from "@aihot/backend/db";
let blocked = false;
try {
  await chatJson({ model: "default", purpose: "studio_writing_draft", subject: "budget-child-request", promptVersion: "budget-settings-v1",
    system: "共享预算", user: "另一进程也不能绕过零预算", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000 });
} catch (error) { blocked = error instanceof Error && /budget/i.test(error.message); }
finally { await closeDb(); }
const { perDay, perMonth } = budgetStatus();
console.log(JSON.stringify({ blocked, perDay, perMonth }));
