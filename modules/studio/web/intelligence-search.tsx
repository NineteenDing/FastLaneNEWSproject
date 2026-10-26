import type { IntelligenceMatch } from "../contracts";

export const matchLabels: Record<IntelligenceMatch["field"], string> = { title: "标题匹配", source: "来源匹配", body: "正文匹配", excerpt: "简介匹配", transcript: "转写匹配" };
/** A literal text match, with React escaping preserved. One mark per text avoids huge search DOMs. */
export function SearchText({ text, query = "", anchor = false }: { text: string; query?: string; anchor?: boolean }) {
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark className="studio-search-mark" id={anchor ? "intelligence-search-match" : undefined} tabIndex={anchor ? -1 : undefined}>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
