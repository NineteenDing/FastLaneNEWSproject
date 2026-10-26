export type FilmBoardRegion = "domestic" | "overseas";
export interface FilmBoardItem {
  sourceSummary?: string | null;
  titleZh?: string | null;
  summaryZh?: string | null;
  id: string;
  position: number;
  title: string;
  url: string;
  author: string | null;
  metrics: Array<{ name: string; value: number | null; text: string }>;
  genreKeys?: string[];
  sourcePlatform?: string | null;
  sourcePlatformLabel?: string | null;
  productionCountries?: string[];
  countryStatus?: "verified" | "not_provided" | "pending" | "failed" | "conflict";
  summaryKind?: "work" | "collection" | "representative_episode" | "missing";
  summaryStatus?: "ready" | "pending" | "source_missing" | "failed";
}
export interface FilmBoardSnapshot {
  items: FilmBoardItem[];
  fetchedAt: string;
  sourceUpdatedText: string | null;
  sourceUrl: string;
  requestedLimit: number;
  schemaVersion?: 2;
  sourceIssueDate?: string | null;
  sourceTotal?: number | null;
  categories?: Array<{ key: string; labelOriginal: string; labelZh?: string | null; sourceCount?: number | null }>;
  platforms?: Array<{ key: string; label: string }>;
}
export interface FilmBoard {
  group?: { id: string; name: string; category: string };
  id: string;
  name: string;
  region: FilmBoardRegion;
  scope: "ai" | "market";
  ordering: "ranking" | "recommendation";
  sourceUrl: string | null;
  note: string;
  supported: boolean;
  retired?: boolean;
  version: number;
  enabled: boolean;
  limit: number;
  state: "pending" | "queued" | "running" | "ready" | "empty" | "failed" | "paused" | "not_connected";
  error: string | null;
  checkedAt: string | null;
  snapshotAt: string | null;
  sourceUpdatedText: string | null;
  requestedLimit: number | null;
  sourceIssueDate?: string | null;
  sourceTotal?: number | null;
  categories?: Array<{ key: string; labelOriginal: string; labelZh?: string | null; sourceCount?: number | null }>;
  platforms?: Array<{ key: string; label: string }>;
  items: FilmBoardItem[];
}
export interface FilmBoardsPage { boards: FilmBoard[] }
