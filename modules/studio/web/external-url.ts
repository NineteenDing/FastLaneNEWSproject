export function externalUrl(value: string | null) {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
