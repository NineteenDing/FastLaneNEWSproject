import { sameTrendHeadline } from "./platform-attention.ts";
import { verifiedModelLaunch } from "./editorial-evidence.ts";
import type { SharedMaterial } from "./shared-material.ts";

/** One existing article represents a discovery; never merge events or award heat to every similar headline. */
export function trendRepresentative<T extends { id: string; title: string; titleZh: string | null; shared: SharedMaterial; linked?: boolean }>(title: string, rows: T[]) {
  const matches = rows.filter(row => sameTrendHeadline(title, row.title) || !!row.titleZh && sameTrendHeadline(title, row.titleZh));
  if (matches.length === 1) return matches[0]!;
  // Several grounded reports of one precise model release are a choice of representative, not uncertain identity.
  // Controversies, reviews and mere announcements fail verifiedModelLaunch or the conservative headline matcher.
  const releases = matches.filter(row => verifiedModelLaunch(row.shared));
  if (!releases.length || releases.length !== matches.length) return null;
  return releases.slice().sort((a,b) => Number(!!b.linked)-Number(!!a.linked) || a.title.length-b.title.length || a.id.localeCompare(b.id))[0]!;
}
