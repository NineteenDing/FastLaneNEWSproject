/** Restore a model quotation to an actual source span, accepting only visual hyphen variants.
 * This does not normalize stored evidence or accept approximate wording/numbers. Ambiguous spans
 * remain unchanged and fail the existing literal grounding check. Comments retain their own source.
 */
export function groundBodyQuoteTypography<T>(data: T, body: string): T {
  const fold = (value: string) => value.replace(/[\u2010\u2011]/g, "-");
  const foldedBody = fold(body);
  function anchor(quote: string) {
    if (body.includes(quote)) return quote;
    const folded = fold(quote), start = foldedBody.indexOf(folded);
    if (!folded || start < 0 || foldedBody.indexOf(folded, start + 1) >= 0) return quote;
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
