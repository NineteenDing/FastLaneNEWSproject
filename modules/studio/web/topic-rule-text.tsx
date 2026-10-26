import type { TopicColumn } from "../contracts";

export function TopicRuleText({ column }: { column: TopicColumn }) {
  return <dl className="studio-column-rules"><div><dt>优先关注</dt><dd>{column.questions}</dd></div><div><dt>希望形成</dt><dd>{column.videoForms}</dd></div>
    <div><dt>入选必须满足</dt><dd>{column.requirements || "沿用固定受众、事实来源与观看收益要求。"}</dd></div>
    <div><dt>通常排除</dt><dd>{column.exclusions || "未另设排除条件。"}</dd></div></dl>;
}
