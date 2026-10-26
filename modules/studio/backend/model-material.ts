import type { TopicBatchMaterial } from "../contracts.ts";

/** The frozen body already contains every transcript word. Models get it once,
 * plus timing/visual provenance; private API/history keep the original full result. */
export function modelMaterial(material: TopicBatchMaterial) {
  // Image download progress is reading metadata, never a reason to repay for the same text analysis.
  const { sourceImages: _sourceImages, ...facts } = material;
  if (facts.source.subject) Object.assign(facts, { creatorIdentityInterpretation: "source.subject.id相同表示用户已确认同一博主；多个平台账号仍属同一人，重复发布不能算多位独立博主或多份独立事实验证。账号和各平台指标分别保留，不相加播放量。" });
  if (facts.source.work) Object.assign(facts, { workIdentityInterpretation: "source.work.id相同表示用户已确认为同一作品的多次发布，不是多个独立创作或事实验证；逐条保留归类和来源，各平台热度与评论分别判断，不把播放量相加。此关联不代表作者相同，也不代表内容事实已核实。" });
  if (facts.commentCoverage?.replySample) Object.assign(facts, { commentInterpretation: "comments中parentExternalId指向同份材料的父评论，回复应连同其父评论理解；replySample只说明实际已采样的范围。一级评论、回复及平台评论总数不可混用，缺口不能解释为无人讨论，也不把同一讨论链算成多个独立事实来源。" });
  if (facts.trends?.length) Object.assign(facts, { trendInterpretation: "榜单标题、排名和原始热度仅是发现线索，不是原稿事实、播放量、独立作者数量或因果证据；仅按对应平台观察范围解释。search_representative是话题搜索取得的一条候选原文，不保证代表全平台讨论；须结合实际正文判断关联性，不能仅凭搜索命中认定结论。" });
  if (!facts.transcript) return facts;
  const { text: _text, segments, ...metadata } = facts.transcript;
  return { ...facts, transcript: { ...metadata, textLocation: "body",
    segments: segments.map(({ start, end, text }) => ({ start, end, characters: Array.from(text).length })) } };
}
