import { z } from "zod";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { HistoryCandidate, MaterialEntity } from "../contracts.ts";

export const historyEntityPolicy = "grounded-entities-v1";
const spelling = (text: string) => text.normalize("NFKC").toLowerCase();
export const historyEntitySchema = z.array(z.object({
  kind: z.enum(["model", "tool", "company", "person", "task", "event", "time"]),
  name: z.string().trim().min(1).max(120), aliases: z.array(z.string().trim().min(1).max(120)).max(8),
  quote: z.string().trim().min(1).max(300),
}).strict()).max(64);

/** Match exactly the source version, not changing metrics, model output or a later batch. */
export function historyEvidenceKey(material: { title: string; body: string; contentVersion: HistoryCandidate["contentVersion"] }) {
  return sha256(stableJson({ title: material.title, body: material.body,
    revision: material.contentVersion.revision, fingerprint: material.contentVersion.fingerprint }));
}

/** Names are retrieval hints grounded in one source, never global identity/ownership claims. */
const flat = (value: string) => spelling(value).replace(/\s+/g, " ").trim();
export function entityGrounded(entity: MaterialEntity, material: { title: string; body: string }) {
  const visible = flat(material.title + "\n" + material.body), quote = flat(entity.quote);
  const names = [entity.name, ...entity.aliases].filter(name => visible.includes(flat(name)));
  // Keep the required name grounded; ungrounded extra aliases are ignored rather than rejecting the whole analysis.
  return names.includes(entity.name) && visible.includes(quote) && names.some(name => quote.includes(flat(name)));
}

export const historyEntityInstructions = "同时输出entities数组（没有则[]）：每项仅kind(model/tool/company/person/task/event/time)、name、aliases、quote。" +
  "提取正文实际涉及的模型/工具、公司、人物、制作任务问题、事件和明确时间；最多24项，quote为正文逐字引文且不超过300字。" +
  "name和aliases都必须在原文标题或正文实际出现，quote中至少出现其中一项；中文英文别名只有原文提供对应依据才关联。" +
  "公司、产品和模型分别记录，Sora不能作为OpenAI的同义名；同名不等于同一实体。事件仅作背景召回，不能将推测当已发生事实。" +
  "时间保留原文写法；没有年份或只有相对时间时不补造日期，发布时间与事件时间不得混同。不要从评论、参考样本或常识补造实体。";
