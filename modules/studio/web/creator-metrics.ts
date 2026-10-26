import type { CreatorContent } from "../contracts";
import { num } from "../../../apps/web/app/features/admin/format";

export function creatorMetricNames(kind?: CreatorContent["kind"]) {
  return [["views", "播放"], ["likes", kind === "answer" || kind === "article" ? "赞同" : "点赞"], ["comments", "评论"], ["reposts", "分享"], ["favorites", "收藏"]] as const;
}

export function creatorMetrics(values: CreatorContent["metrics"], kind?: CreatorContent["kind"]) {
  return creatorMetricNames(kind)
    .filter(([key]) => values[key] !== undefined && values[key] !== null)
    .map(([key, label]) => `${label} ${num(values[key])}`).join(" · ") || "平台未提供互动指标";
}
