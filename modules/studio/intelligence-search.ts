/** Literal, bounded context around the first match; text remains text, never HTML. */
export function searchSnippet(text: string, query: string): string | null {
  if (!query) return null;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  let start = Math.max(0, index - 24), end = Math.min(text.length, index + query.length + 100);
  if (start && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
  return (start ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
