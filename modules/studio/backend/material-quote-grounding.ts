/** Restore a model quotation to an actual source span, accepting visual variants or one bounded omission.
 * This does not normalize stored evidence or accept approximate wording/numbers. Ambiguous spans
 * remain unchanged and fail the existing literal grounding check. Comments retain their own source.
 */
export function groundBodyQuoteTypography<T>(data: T, body: string): T {
  const fold = (value: string) => value.replace(/[\u2010\u2011]/g, "-").replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\u00a0/g,' ');
  const foldedBody = fold(body);
  function anchor(quote: string) {
    if (body.includes(quote)) return quote;
    const folded = fold(quote), start = foldedBody.indexOf(folded);
    if (!folded) return quote;
    if (start < 0) {
      const parts = folded.split(/\.{3}|…+/).map(part => part.trim());
      if (parts.length !== 2 || parts.some(part => part.length < 16)) return quote;
      const left = foldedBody.indexOf(parts[0]!);
      if (left < 0 || foldedBody.indexOf(parts[0]!, left + 1) >= 0) return quote;
      const right = foldedBody.indexOf(parts[1]!, left + parts[0]!.length);
      const end = right + parts[1]!.length;
      const another = foldedBody.indexOf(parts[1]!, right + 1);
      if (right < 0 || right - left - parts[0]!.length > 160 || end - left > 600
        || another >= 0 && another - left - parts[0]!.length <= 160
        || /\n\s*\n/.test(body.slice(left, end))) return quote;
      return body.slice(left, end);
    }
    if (foldedBody.indexOf(folded, start + 1) >= 0) return quote;
    return body.slice(start, start + quote.length);
  }
  function visit(value: unknown, key = ""): unknown {
    // Comment evidence must still match the identified comment, never the article body.
    if (key === "commentFocus") return value;
    if (key === "quote" && typeof value === "string") return anchor(value);
    if (["quotes", "evidenceQuotes", "scopeQuotes"].includes(key) && Array.isArray(value))
      return value.map(item => typeof item === "string" ? anchor(item) : item);
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  }
  return visit(data) as T;
}
