import { z } from "zod";
import type { MaterialEntity, TopicBatchMaterial, TopicColumn } from "../contracts.ts";
import { hasComparableDemandSignal, initialMaterialScore } from "./topic-scoring.ts";

const score = z.number().min(0).max(100).nullable();
/** Accept the richer event object some compatible models emit, keeping its label as the top-level event. */
const eventLabel = (value: unknown) => value && typeof value === "object"
  ? String((value as { label?: unknown; identity?: unknown; text?: unknown }).label
      ?? (value as { identity?: unknown }).identity ?? (value as { text?: unknown }).text ?? JSON.stringify(value)).slice(0, 200)
  : value;
/** Compatible models often explain gates as "pass"/"fail" text instead of booleans. */
const gateBoolean = (value: unknown) => typeof value === "boolean" ? value
  : typeof value === "string" ? !/^(fail|no|false|不通过|否|不满足)/i.test(value.trim()) : value;
export const assessment = z.object({ columnId: z.string(), disposition: z.enum(["support", "background", "duplicate", "not_topic", "pending"]),
  summary: z.string().min(1).max(600), reason: z.string().min(1).max(500), viewerBenefit: z.string().max(500).nullable(),
  event: z.preprocess(eventLabel, z.string().max(200).nullable()), evidenceQuotes: z.array(z.string().min(1).max(600)).max(12),
  gates: z.preprocess(value => value && typeof value === "object" ? {
    audience: gateBoolean((value as Record<string, unknown>).audience),
    evidence: gateBoolean((value as Record<string, unknown>).evidence),
    benefit: gateBoolean((value as Record<string, unknown>).benefit),
  } : value, z.object({ audience: z.boolean(), evidence: z.boolean(), benefit: z.boolean() }).strict()),
  dimensions: z.object({ audience: score, practical: score, evidence: score, freshness: score, demand: score, distinctiveness: score }).strict(),
}).strict();

/** Both request generations keep the same evidence gates and missing-data treatment. */
export function materialAssessmentResult(data: z.infer<typeof assessment> & { entities?: MaterialEntity[] }, evidence: TopicBatchMaterial, expectEntities: boolean, columns: TopicColumn[]) {
  const dimensions = { ...data.dimensions, demand: hasComparableDemandSignal(evidence) ? data.dimensions.demand : null,
    freshness: evidence.freshness === "undated" ? null : data.dimensions.freshness };
  const completeBody = ["ok", "collected", "transcribed"].includes(evidence.bodyState) && !!evidence.body.trim();
  const disposition = completeBody ? data.disposition : "pending";
  const gates = { audience: data.gates.audience && (dimensions.audience ?? 0) > 0,
    evidence: data.gates.evidence && completeBody && (dimensions.evidence ?? 0) > 0,
    benefit: data.gates.benefit && !!data.viewerBenefit?.trim() };
  const score = initialMaterialScore(dimensions, gates);
  const column = columns.find(column => column.id === data.columnId);
  return { ...data, disposition, gates, dimensions, scope: "material_initial", columnSnapshot: column ? { id: column.id, name: column.name, version: column.version } : null,
    gaps: [...(completeBody ? [] : ["正文或转写尚未完整取得"]), ...(evidence.freshness === "undated" ? ["发布时间尚未核实"] : []),
      ...(expectEntities && !data.entities ? ["未取得结构化名称与事件"] : [])],
    score: { ...score, eligible: score.eligible && !["pending", "duplicate", "not_topic"].includes(disposition) } };
}
