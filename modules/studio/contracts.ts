/** Private workbench read model. Collector configs and raw errors never belong in cards. */
export type CreatorPlatform = "xhs" | "douyin" | "kuaishou" | "bilibili" | "weibo" | "tieba" | "zhihu";
export type TrendPlatform = CreatorPlatform | "baidu";
export interface TrendBoards {
  collectionEnabled: boolean;
  rows: Array<{ platform: TrendPlatform; name: string; homepage: string; supported: boolean; unsupportedReason: string | null; connected: boolean;
    collection: { state: string; checkedAt: string | null; itemCount: number | null; errorCode: string | null } | null;
    source: { id: string; name: string; enabled: boolean; archived: boolean; version: string } | null }>;
}
export interface TrendSignal {
  id: string; platform: TrendPlatform; title: string; url: string; disposition: string; firstSeenAt: string; lastSeenAt: string;
  observations: Array<{ observedAt: string; rank: number; rawHeat: string | null; metrics: { views: number | null; likes: number | null; comments: number | null } }>;
  relevance: { state: string; result: { decision: "relevant" | "excluded" | "uncertain"; reason: string; titleQuote: string; viewerProblem: string | null } | null;
    receiptId: number | null; error: string | null; policy: string; modelIdentity: string } | null;
  deepRead?: { state: string; materialId: string | null; errorCode: string | null; charged: boolean; budgetDay: string } | null;
}
export interface MaterialTrend {
  id: string; platform: TrendPlatform; title: string; url: string; method: "direct_content" | "search_representative";
  active?: boolean;
  observations: Array<TrendSignal["observations"][number] & { bestRank?: number }>;
}
export interface TopicColumn {
  id: string; version: number; name: string; questions: string; videoForms: string;
  requirements: string; exclusions: string; sortOrder: number; enabled: boolean;
  isFallback: boolean; maxDirections: 3 | 5;
}
export interface TopicColumns { audience: string; rows: TopicColumn[] }
export interface EditorialPolicyV2 {
  schemaVersion: 2;
  policyVersion: string;
  public: {
    weights: { interest: number; impact: number; substance: number; practical: number; freshness: number; heat: number };
    all: { S: number; B: number; I: number; D: number; compensatedB: number };
    selected: { S: number; B: number; I: number; D: number; compensatedB: number };
    general: { S: number; M: number; I: number; D: number; compensatedB: number };
    nonAi: { M: number; I: number; D: number; S: number };
    major: { M: number; I: number; D: number };
  };
  internal: {
    weights: { heat: number; interest: number; impact: number; evidence: number; distinctiveness: number; practical: number; freshness: number };
    normal: { I: number; E: number; S: number; compensatedB: number };
  };
  heat: { halfLifeHours: number; decisionPlaceholder: number;
    reporterAnchors: Array<[number, number]>; videoAnchors: Array<[number, number]> };
  freshness: { anchors: Array<[number, number]>; validBackfillValue: number; unknownDecision: number };
  windows: { allHours: number; selectedHours: number; hotHours: number; dailyHours: number; lateHours: number; policyHours: number };
  breakout: { reports: number; views: number; authors: number; freshHours: number };
  daily: { headlineBandMax: number; headlineBandRatio: number; volumeRatio: number; emergencyHeat: number };
}
export interface FilterPolicy {
  version: number;
  schemaVersion?: 2;
  /** Built-in editorial-v2 parameters; absent means this row still describes the legacy v1 policy. */
  editorial?: EditorialPolicyV2;
  public: { weights: { practical: number; interest: number; heat: number; substance: number; freshness: number };
    selectedAbove: number; minimumPractical: number; allowBreakout: boolean };
  internal: { weights: { heat: number; freshness: number; impact: number; practical: number; evidence: number; distinctiveness: number } };
  propagation: EventPropagationRules;
  heat: { halfLifeHours: number; reporterBands: Array<{ at: number; value: number }>; videoBands: Array<{ at: number; value: number }> };
  freshness: { bands: Array<{ hours: number; value: number }>; backgroundValue: number; repostValue: number };
  columnMapping: Record<string, "practice" | "models" | "news" | "cases" | null>;
}
export interface EventTime { at: string; precision: "instant" | "day"; quote: string }
export interface EventHeat { value: number; reporterScore: number; platformScores: Array<{ platform: string; value: number | null }>; halfLifeHours: number }
export interface FilterMaterialScore {
  materialId: string; policyVersion: number; asOf: string; eventId: string | null;
  public: { total: number; values: Record<keyof FilterPolicy["public"]["weights"], number | null>;
    contributions: Record<keyof FilterPolicy["public"]["weights"] | "impact", number>;
    destination: "selected_candidate" | "all_candidate" | "excluded" | "pending" | "private"; reasons: string[] };
  internal: { total: number; values: Record<keyof FilterPolicy["internal"]["weights"], number | null>; contributions: Record<keyof FilterPolicy["internal"]["weights"], number>; eligible: boolean; gaps: string[] };
  freshness: { at: string | null; basis: "event_evidence" | "unknown"; precision: EventTime["precision"] | null; ageHours: number | null; value: number | null };
  heat: EventHeat | null; breakout: EventObservation["breakout"] | null;
  columnMatches: Array<{ columnId: string; value: number; reason: string; publicColumn: FilterPolicy["columnMapping"][string] }>;
  route?: "model_release" | "direct_all" | "direct_selected" | "major_event" | "verified_breakout" | "general_ai_selected" | "market_reference" | "excluded" | "pending" | "private";
  eligiblePublic?: boolean; eligibleSelected?: boolean; base?: number; B?: number; interval?: [number, number];
  heatState?: "complete" | "partial" | "unknown"; heatObserved?: number | null; heatFresh?: number | null; heatDecision?: number; heatCompensated?: boolean;
  summaryState?: "ok" | "pending" | "missing"; reasonCodes?: string[];
}
export interface FilterPreview {
  policyVersion: number; startsAt: string; asOf: string; total: number; changedCount: number; page: number; hasMore: boolean;
  rows: Array<{ materialId: string; title: string; before: FilterMaterialScore; after: FilterMaterialScore;
    beforeRank: number | null; afterRank: number | null; beforeInternalRank: number; afterInternalRank: number; changed: boolean }>;
  directionTotal: number; directionPage: number; directionHasMore: boolean;
  directions: Array<{ id: string; columnId: string; title: string; before: TopicDirection; after: TopicDirection; beforeRank: number; afterRank: number; changed: boolean }>;
}
export interface PlatformSession {
  platform: CreatorPlatform; state: "saved" | "missing" | "unreadable"; verified: false;
  version: number; updatedAt: string | null; adapterAvailable: boolean; loginRequired?:boolean;
}
export interface CreatorAccount {
  identity?: { stableId: string; aliases: string[] } | null;
  id: string; platform: CreatorPlatform; locator: string; homepage: string;
  subject: { id: string; name: string } | null;
  name: string | null; description: string | null; avatarUrl: string | null;
  followerCount: number | null; workCount: number | null;
  latestPublishedAt: string | null; lastCheckedAt: string | null; addedAt: string;
  profileState: "pending" | "ready" | "failed"; collectionState: "not_connected" | "running" | "ready" | "failed" | "interrupted" | "login_required" | "rate_limited";
  collectionCoverage: { page: number; nextPage: number | null; complete: boolean } | null;
  collectionSupported: boolean;
  collectedCount: number; version: number; enabled: boolean; archived: boolean;
}
export interface CreatorAccounts { rows: CreatorAccount[]; total: number; page: number; hasMore: boolean }
export interface CreatorContent {
  id: string; externalId: string; url: string; title: string; text: string; publishedAt: string | null; transcript: null;
  collectedAt: string; updatedAt: string;
  kind?: "video" | "post" | "image_text" | "answer" | "article";
  parent?: { kind: "question" | "column"; url: string; title: string };
  metrics: { views: number | null; comments: number | null; likes?: number | null; reposts?: number | null; favorites?: number | null };
  comments: Array<{ externalId: string; text: string; likes: number | null; publishedAt: string | null; floor?: number; parentExternalId?: string }>;
  commentCoverage: { complete: boolean; repliesComplete: boolean; limit: 20;
    replySample?: { count: number; limit: 20; parentsChecked: number; parentsPending: number; requests: number } };
  observations: Array<{ observedAt: string; metrics: CreatorContent["metrics"] }>;
}
export interface CreatorContents { rows: CreatorContent[]; total: number; page: number; hasMore: boolean }

export interface CreatorExpressionPattern {
  dimension: "title" | "opening" | "development" | "rhythm" | "tone" | "ending";
  observation: string; application: string; possibleEffect: string; limitations: string;
  evidence: Array<{ materialId: string; quote: string }>;
}
export interface CreatorExpressionLibrary {
  id: string; creatorId: string; creatorName: string; createdAt: string;
  patterns: CreatorExpressionPattern[];
  sources: Array<{ materialId: string; title: string; url: string; publishedAt: string | null; sourceKey: string }>;
}
export interface CreatorExpressions {
  state: "not_started" | "queued" | "running" | "completed" | "failed" | "superseded";
  runId: string | null; error: string | null; modelEnabled: boolean;
  library: CreatorExpressionLibrary | null; changedMaterialIds: string[];
}

export interface IntelligenceRow {
  originalTitle?: string;
  match?: IntelligenceMatch;
  id: string; kind: "news" | NonNullable<CreatorContent["kind"]>; title: string; excerpt: string;
  publishedAt: string | null; collectedAt: string; updatedAt: string;
  source: { id: string; name: string; platform: "news" | CreatorPlatform; homepage: string | null; avatarUrl: string | null;
    subject?: { id: string; name: string }; work?: CreatorWorkRef; reporterId?: string };
  metrics: CreatorContent["metrics"] | null;
  processingState: string; analysisState: "not_connected" | MaterialAnalysisState;
}
export interface IntelligenceList { rows: IntelligenceRow[]; total: number; page: number; hasMore: boolean }
export interface IntelligenceMatch { field: "title" | "source" | "body" | "excerpt" | "transcript"; text: string }
export interface CreatorWorkRef { id: string; title: string; version: number; publicationCount: number }
export interface CreatorWork {
  id: string; title: string; version: number;
  publications: Array<{ id: string; title: string; url: string; platform: CreatorPlatform; kind: NonNullable<CreatorContent["kind"]>; creatorName: string;
    publishedAt: string | null; metrics: CreatorContent["metrics"] }>;
}
export interface IntelligenceDates {
  basis: "collected" | "published"; month: string;
  months: Array<{ month: string; total: number }>;
  days: Array<{ day: string; total: number }>;
  undatedTotal: number;
}
/** Local signal observations; low energy is not voice VAD, sampled changes are not exact cuts. */
export interface MediaRhythm {
  version: 1;
  audio: { method: "rms_20ms_v1"; timeBasis: "decoded_audio"; observedSeconds: number; quietThresholdDbfs: -40; minimumQuietSeconds: 0.3; quietSeconds: number;
    quietIntervalCount: number; quietIntervals: Array<{ start: number; end: number }>; truncated: boolean;
    windows: Array<{ start: number; end: number; rmsDbfs: number; quietFraction: number }> } | null;
  visual: { method: "sampled_rgb_v1"; timeBasis: "video_elapsed"; sampleIntervalSeconds: 0.5; changeThreshold: 0.18; sampleCount: number; sampledUntilSeconds: number;
    changeCount: number; changeTimes: number[]; truncated: boolean; windows: Array<{ start: number; end: number; samples: number; changes: number }> } | null;
}
export type SourceImage = { assetId: string; url: string; sourceUrl: string; articleUrl: string; revision: number; description: string; rights: "unknown" };
export interface SourceImages {
  versionKey: string; revision: number; state: "empty" | "not_requested" | "pending" | "queued" | "running" | "ready" | "failed";
  enabled: boolean; candidateCount: number; images: SourceImage[]; error: string | null; updatedAt: string | null;
}
export interface IntelligenceDetail extends IntelligenceRow {
  trends?: MaterialTrend[];
  sourceImages?: SourceImages;
  analysis?: MaterialAnalysisReading | null;
  transcript?: { text: string; language: string; durationSeconds: number; model: string; method: "local_asr" | "platform_subtitle";
    segments: Array<{ start: number; end: number; text: string }>; mediaState: "cleaned" | "cleanup_pending"; visualEvidence: "not_observed" | "keyframes_saved";
    frames?: Array<{ timeSeconds: number; assetId: string; url: string }>; rhythm?: MediaRhythm } | null;
  url: string; body: string; bodyState: string;
  comments: CreatorContent["comments"]; commentCoverage: CreatorContent["commentCoverage"] | null;
  observations: CreatorContent["observations"]; parent: CreatorContent["parent"] | null;
}

export interface NewsSourceCard {
  id: string;
  name: string;
  kind: string;
  tags: string[];
  enabled: boolean;
  archived: boolean;
  health: string;
  failureWarning?: { count: number; firstFailedAt: string; lastFailedAt: string } | null;
  lastCheckedAt: string | null;
  latestPublishedAt: string | null;
  collectedCount: number;
  addedAt: string;
  version: string;
  description: string | null;
  region: string | null;
  language: string | null;
  homepage: string | null;
  profileVersion: number;
  avatarUrl: string | null;
  metadata: { state: "ok" | "failed" | "needs_homepage"; checkedAt: string; iconState: "ok" | "missing" | "failed" | "unknown" } | null;
  validation: { state: "ok" | "failed" | "needs_config"; checkedAt: string; itemCount: number | null } | null;
}

export interface NewsSources {
  rows: NewsSourceCard[];
  total: number;
  page: number;
  hasMore: boolean;
  regionOptions: Array<{ region: string | null; count: number }>;
}

export interface NewsSourceSettings {
  id: string;
  name: string;
  kind: "rss" | "web_list";
  url: string;
  config: Record<string, unknown>;
  intervalMinutes: number;
  version: string;
}

export interface NewsBridgeSettings {
  id: string;
  name: string;
  route: string | null;
  itemLimit: number;
  aiFilter: boolean;
  origin: "legacy" | "custom" | "missing";
  version: string;
  runtimeState: "not_configured" | "configured" | "invalid";
}

/** Logical reservations cover managed temporary workspaces; this is not all application storage. */
export interface StorageStatus {
  availableBytes: number;
  reservedBytes: number;
  keepFreeBytes: number;
}

export type MaterialEntity = {
  kind: "model" | "tool" | "company" | "person" | "task" | "event" | "time";
  name: string;
  aliases: string[];
  quote: string;
};

export interface HistoryCandidate extends Pick<IntelligenceRow, "id" | "kind" | "title" | "excerpt" | "source" | "publishedAt" | "collectedAt"> {
  url: string;
  contentVersion: { revision: number | null; fingerprint: string | null; transcriptSavedAt?: string | null };
  fingerprint: string;
  matchedTerms: string[];
  reason: string;
  entities?: MaterialEntity[] | null;
}

export interface HistorySearch {
  rows: HistoryCandidate[];
  limit: number;
  coverage: "incremental_only" | "backfilled";
}

export interface HistoryIndexStatus {
  policy: string;
  indexedPolicy: string | null;
  runId: string | null;
  state: "not_started" | "queued" | "running" | "completed" | "failed" | "outdated";
  phase: "news" | "creator" | "done";
  processed: number;
  batchSize: number;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface TopicHistorySnapshot {
  policy: string;
  frozenAt: string;
  candidateCount: number;
  candidateLimit: number;
  evidenceLimit: number;
  omittedQueryTerms: number;
  coverage: HistorySearch["coverage"];
  items: Array<{ material: TopicBatchMaterial; fingerprint: string; reason: string;
    anchors: Array<{ kind: "text"; paragraph: number; start: number; end: number; unit: "utf16"; quote: string }
      | { kind: "video"; startSeconds: number; endSeconds: number; quote: string }> }>;
}

export type TopicHistoryPage = (TopicHistorySnapshot & { state: "ready"; policyChanged: boolean; changedMaterialIds: string[] })
  | { state: "not_prepared"; items: []; changedMaterialIds: string[] };

export interface HistorySettings { version: number; candidateLimit: number; evidenceLimit: number }

/** Closed evidence and rule versions; freezing does not mean recommendations were generated. */
export interface TopicBatch {
  id: string;
  rootBatchId?: string | null;
  revision?: number;
  startsAt: string;
  endsAt: string;
  frozenAt: string;
  audience: string;
  columns: TopicColumn[];
  materialCount: number;
  timeZone: "Asia/Hong_Kong";
  stage: "frozen";
  recommendationState: "not_generated" | "draft" | "reviewed";
  reviewVerdict: TopicReview["verdict"];
  adoptionState: "not_adopted" | "adopted";
  selectionState?: "not_adopted" | "adopted" | "incomplete";
  draftCount: number;
  adoptedDirectionCount: number;
  adoptedDirectionIds?: string[];
  finalizedDraftCount?: number;
}

export interface TopicBatchMaterial extends IntelligenceDetail {
  suggestedColumnIds?: string[];
  arrivedLate: boolean;
  freshness: "current" | "background" | "undated";
  contentVersion: { revision: number | null; fingerprint: string | null };
}

export interface SourceCoverageRow {
  id: string; name: string; kind: "news" | "creator" | "trend"; platform: string; enabled: boolean;
  lastCheckedAt: string | null; lastAttemptAt: string | null; pagesComplete: boolean | null; page: number | null; nextPage: number | null;
  state: "paused" | "not_checked" | "checked" | "partial" | "running" | "failed" | "login_required" | "rate_limited" | "interrupted" | "after_window";
}
export interface SourceCoverageSnapshot {
  policy: "studio-source-coverage-v1"; capturedAt: string; startsAt: string; endsAt: string;
  counts: Record<SourceCoverageRow["state"], number>; rows: SourceCoverageRow[];
}
export interface SourceCoveragePage {
  state: "current" | "snapshot" | "unavailable"; capturedAt: string | null; startsAt: string | null; endsAt: string | null;
  counts: SourceCoverageSnapshot["counts"] | null; rows: SourceCoverageRow[]; total: number; page: number; hasMore: boolean;
}

export interface TopicPlan {
  version: number;
  enabled: boolean;
  startsAt: string;
  timeZone: "Asia/Hong_Kong";
  intervalHours: 48;
  anchorLocked: boolean;
}

export interface CurrentTopicBatch {
  startsAt: string;
  endsAt: string;
  timeZone: "Asia/Hong_Kong";
  stage: "collecting" | "scheduled";
  recommendationState: "not_generated";
  materialCount: number;
  analysisPendingCount: number;
  analysisCompletedCount: number;
  videoWithoutTranscriptCount: number;
}

export interface TopicPresentation {
  collection: CurrentTopicBatch;
  batch: TopicBatch | null;
  displayUntil: string | null;
}

export interface CurrentTopicPreview extends CurrentTopicBatch {
  state: "not_generated" | "queued" | "running" | "draft" | "failed";
  stale: boolean;
  result: TopicRecommendationResult | null;
  generatedAt: string | null;
  reviewState: "not_started";
  modelEnabled: boolean;
  includedMaterialCount: number;
  inputIssue?: string | null;
  id?: string; version?: number; capturedAt?: string; columns?: TopicColumn[];
  referenceMaterials?: TopicRecommendations["referenceMaterials"];
  error?: string | null;
}

export interface TopicMaterialPage {
  rows: TopicBatchMaterial[];
  total: number;
  page: number;
  hasMore: boolean;
}

export type MaterialDimensions = Record<"audience" | "practical" | "evidence" | "freshness" | "demand" | "distinctiveness", number | null>;
export interface TopicFeedback { version: number; rating: "useful" | "not_useful" | null; reason: string; updatedAt: string | null }
export interface TopicFeedbackSample {
  batchId: string; directionId: string; version: number; rating: NonNullable<TopicFeedback["rating"]>; reason: string;
  direction: Pick<TopicDirection, "columnId" | "eventKey" | "question" | "angle">;
}
export interface TopicAdoptionSample {
  projectId: string; batchId: string; directionId: string; columnId: string; eventKey: string; angle: string; quotes: string[];
}
export interface EventPropagationRules { windowHours: number; independentReports: number; observedViews: number; independentAuthors: number; allowMeme: boolean }
export interface EventObservation {
  propagation: { windowHours: number; startsAt: string; asOf: string; mentionCount: number; reportCount: number; independentReporters: number;
    independentParticipants: number; independentOriginalReporters: number;
    platforms: Array<{ platform: string; observedViews: number | null; independentAuthors: number; workCount: number; measuredWorkCount: number; publicationCount: number }> };
  breakout: { triggered: boolean; reasons: string[]; candidate: boolean };
}
export interface SharedTopicSignals {
  policy: "shared-topic-v1" | "shared-topic-v2"; asOf: string; rules: EventPropagationRules;
  events: Array<EventObservation & { id: string; label: string; materialIds: string[]; heat?: EventHeat; time?: EventTime | null; timeConflict?: boolean; publicationFallbackAt?: string; allReposts?: boolean;
    heatObserved?: number | null; heatFresh?: number | null; heatState?: "complete" | "partial" | "unknown"; heatDecision?: number; heatCompensated?: boolean;
    interval?: [number, number]; policyVersion?: string }>;
  candidates: Array<{ materialId: string; eventId: string; scope: "direct" | "important_ai" | "unrelated" | "uncertain"; editorialScope?: EditorialScopeV2;
    evidenceAvailable: boolean; directBenefit?: boolean;
    path: "direct" | "important_ai" | "breakout" | "major_event" | "general_ai" | "market_reference" | null;
    route?: string; reason: string }>;
}
export type DirectionRankingContext = ({ policy: "studio-direction-ranking-v2"; asOf: string }
  | { policy: "studio-direction-ranking-v3-feedback"; asOf: string; feedback: TopicFeedbackSample[] }
  | { policy: "studio-direction-ranking-v4-adoption"; asOf: string; feedback: TopicFeedbackSample[]; adopted: TopicAdoptionSample[] }) & { sharedSignals?: SharedTopicSignals; filterPolicy?: FilterPolicy; materialIds?:string[];materialAnalyses?:Record<string,TopicMaterialAnalysis> };
export interface TopicDirection {
  id: string; columnId: string; eventKey: string;
  /** Heat and major/breakout exceptions belong to this core event, not to every cited background event. */
  primaryCoreEventId?: string; additionalCoreEventIds?: string[];
  question: string; viewerBenefit: string; whyNow: string; angle: string;
  usage: { steps: string[]; conditions: string[]; limitations: string[] };
  titles: string[]; preferredTitle: number;
  structure: { opening: string; rhythm: string; ending: string };
  references: Array<{ materialId: string; role: "fact" | "expression" | "counterpoint"; quote: string; reason: string }>;
  dimensions: MaterialDimensions & { impact?: number | null };
  gates: { audience: boolean; evidence: boolean; benefit: boolean };
  score: NonNullable<TopicMaterialAnalysis["score"]> & { scope: "direction"; configured?: FilterMaterialScore["internal"] & { policyVersion: number }; ranking?: {
    policy: DirectionRankingContext["policy"]; asOf: string; baseTotal: number; freshnessFactor: number | null; timeAdjustment: number; diversityAdjustment: number;
    preferenceAdjustment?: number; feedbackMatches?: number;
    adoptionAdjustment?: number; previousProjectId?: string;
  } };
}
export interface TopicRecommendationResult {
  sharedSignals?: SharedTopicSignals;
  filterPolicy?: FilterPolicy;
  directions: TopicDirection[];
  assignments: Array<{ materialId: string; columnId: string; disposition: NonNullable<TopicMaterialAnalysis["disposition"]>; directionIds: string[]; reason: string }>;
}
export interface TopicGapReport {
 total:number;completed:number;unanalysed:number;used:number;page:number;hasMore:boolean;
 rows:Array<{materialId:string;title:string;state:string;reason:string;canFetchBody:boolean}>;
 fallback?:{result:TopicRecommendationResult;referenceMaterials:TopicRecommendations['referenceMaterials']};
}
export interface TopicRecommendations {
  state: "not_generated" | "queued" | "running" | "draft" | "failed";
  result: TopicRecommendationResult | null;
  receiptId: number | null; error: string | null;
  reviewState: TopicReview["state"];
  modelEnabled: boolean;
  referenceMaterials: Array<Pick<TopicBatchMaterial, "id" | "title" | "url" | "source" | "excerpt"> & Partial<Pick<TopicBatchMaterial, "kind" | "metrics" | "publishedAt">>>;
}
export interface TopicReviewOpinion {
  id: string;
  directionIds: string[];
  materialIds: string[];
  kind: "coverage" | "classification" | "duplicate" | "evidence" | "demand" | "promise" | "timing";
  severity: "blocking" | "major" | "minor";
  problem: string;
  suggestion: string;
}
export interface TopicReview {
  state: "not_started" | "queued" | "running" | "completed" | "failed";
  verdict: "passed" | "revised" | "no_materials" | null;
  result: TopicRecommendationResult | null;
  rounds: Array<{ round: 1 | 2; passed: boolean; summary: string; opinions: TopicReviewOpinion[] }>;
  summary: string | null;
  decisions: Array<{ opinionId: string; decision: "accept" | "partial" | "reject"; reason: string }>;
  error: string | null;
  modelEnabled: boolean;
  completedSteps: number;
  referenceMaterials: TopicRecommendations["referenceMaterials"];
}
export interface WritingContent { spoken: string; production: string; notes: string }
export interface WritingRevision {
  id: string; requestId: string; baseVersion: number; field: keyof WritingContent; instruction: string;
  rules?: { source: "latest"; skills: WritingProject["snapshot"]["skills"] };
  state: "queued" | "running" | "completed" | "failed"; applied: boolean; error: string | null;
  result: { before: string; after: string; reason: string; issues: Array<{ severity: "blocking" | "major" | "minor"; problem: string; suggestion: string }>; checked: boolean } | null;
}
export interface WritingImage {
  assetId: string; name: string; url: string; createdAt: string;
  source: { kind: "upload" } | { kind: "news"; materialId: string; originalUrl: string;
    articleUrl?: string; revision?: number; rights?: "unknown" };
}
export interface ReferenceAnalysisResult {
  videos: Array<{ materialId: string; observations: Array<{ assetId: string; timeSeconds: number;
    phase: "opening" | "development" | "ending"; observation: string; possibleEffect: string }>;
    textualTone: { quote: string; observation: string; possibleEffect: string }; limitations: string[] }>;
}
export interface WritingReferenceAnalysis {
  id: string; policy: string; model: string; inputHash: string; result: ReferenceAnalysisResult;
  videos: Array<{ materialId: string; frames: Array<{ assetId: string; timeSeconds: number; url: string }> }>;
}
export interface WritingProject {
  id: string;
  batchId: string;
  title: string;
  titleOptions?: string[];
  confirmedVersion?: number | null;
  confirmedTitle?: string | null;
  instructions: string;
  version: number;
  state: "draft" | "final";
  content: WritingContent;
  createdAt: string;
  updatedAt: string;
  historyChanges?: { policyChanged: boolean; changedMaterialIds: string[] };
  snapshot: {
    batch: { id: string; startsAt: string; endsAt: string };
    copiedFrom?: { projectId: string; version: number };
    audience: string;
    columns: TopicColumn[];
    directions: TopicDirection[];
    materials: TopicBatchMaterial[];
    references: Array<{ materialId: string; role: "fact" | "expression" | "counterpoint" }>;
    supplementalMaterialIds?: string[];
    skills: Array<{ id: string; version: string; name: string; body: string }>;
    languageSamples?: LanguageSample[];
    expressionLibraries?: CreatorExpressionLibrary[];
    referenceAnalysis?: WritingReferenceAnalysis;
    history?: { policy: string; frozenAt: string; items: Array<{ materialId: string; fingerprint: string; reason: string;
      anchors: TopicHistorySnapshot["items"][number]["anchors"] }> };
    reviewVerdict: NonNullable<TopicReview["verdict"]>;
  };
}
export interface WritingProjectPage { rows: WritingProject[]; total: number; page: number; hasMore: boolean }
export interface LanguageSample {
  projectId: string; version: number; title: string; spoken: string; columnIds: string[];
  confirmedAt: string; source: "confirmed_final";
}
export interface LanguageSamplePage { rows: LanguageSample[]; total: number; page: number; hasMore: boolean }
export interface WritingVersion {
  version: number; title: string; instructions: string; content: WritingContent;
  titleOptions?: string[];
  skills?: WritingProject["snapshot"]["skills"];
  source: "created" | "manual" | "auto" | "model" | "final" | "restore";
  createdAt: string;
}
export interface WritingSkill {
  id: string; version: number; name: string; body: string;
  enabled: boolean; priority: number; columnIds: string[]; builtin: boolean; createdAt: string | null;
}
export interface WritingSkillVersionPage { rows: WritingSkill[]; total: number; page: number; hasMore: boolean; currentVersion: number }
export interface StyleRule {
  key: string; body: string; evidence: Array<{ projectId: string; version: number; quote: string }>;
}
export interface StyleCandidate { summary: string; rules: StyleRule[] }
export interface StyleLearningConfig { version: number; skillId: string | null; lockedRules: StyleRule[] }
export interface StyleLearningSettings { config: StyleLearningConfig; rules: StyleRule[]; skillVersion: number | null }
export interface StyleLearningEvaluation {
  projectId: string; version: number; baseline: string; trial: string;
  checks: Array<{ criterion: "facts" | "attribution" | "conditions" | "experience" | "title" | "readability" | "templates" | "duration";
    baselinePass: boolean; candidatePass: boolean; reason: string; baselineQuote: string; candidateQuote: string; materialId: string | null; sourceQuote: string }>;
}
export interface StyleLearningInput {
  column: TopicColumn;
  training: LanguageSample[];
  editExamples?: Array<{ projectId: string; finalVersion: number; baselineVersion: number; beforeSpoken: string }>;
  heldOut: Array<{ sample: LanguageSample; prompt: {
    title: string; instructions: string; audience: string; columns: TopicColumn[]; directions: TopicDirection[];
    materials: TopicBatchMaterial[]; references: WritingProject["snapshot"]["references"];
  } }>;
  observedSamples: Array<{ projectId: string; version: number }>;
  skills: WritingProject["snapshot"]["skills"];
  config: StyleLearningConfig;
  baseSkill: WritingSkill | null;
}
export interface StyleLearningRun {
  id: string; columnId: string; state: "queued" | "running" | "candidate" | "activated" | "retained" | "failed";
  input: StyleLearningInput; result: { candidate: StyleCandidate; evaluations?: StyleLearningEvaluation[];
    activatedSkill?: { id: string; version: number } | null; reason?: string } | null;
  error: string | null; createdAt: string; updatedAt: string; completedSteps: number;
}
export interface WritingGeneration {
  id: string | null;
  state: "not_started" | "queued" | "running" | "completed" | "proposal" | "failed";
  quality: "checked" | "needs_attention" | null;
  error: string | null;
  modelEnabled: boolean;
  result: {
    title?: string;
    titleOptions?: string[];
    applied: boolean;
    content: WritingContent;
    facts: Array<{ materialId: string; quote: string; claim: string }>;
    expressionReferences: Array<{ materialId: string; observations: string; limitations: string }>;
    shots: Array<{ startSeconds: number; endSeconds: number; visual: string; captureMethod: "screen_recording" | "graphic" | "footage"; assetIds: string[] }>;
    issues: Array<{ severity: "blocking" | "major" | "minor"; problem: string; suggestion: string }>;
    duration: { kind: "estimated"; seconds: number; basis: string };
  } | null;
}
export type MaterialInsights = {
  policy: string;
  commentSample: { count: number; complete: boolean | null; repliesComplete: boolean | null };
  commentFocus: Array<{ point: string; evidence: Array<{ commentId: string; quote: string }> }>;
  impacts: Array<{ effect: string; conditions: string; kind: "reported" | "inferred"; evidenceQuotes: string[] }>;
};
export type EditorialScopeV2 = "direct_ai_film" | "general_ai" | "adjacent_industry" | "non_ai_film" | "unrelated" | "uncertain";
export interface SemanticDimensionV2 { value: number | null; reason: string; factIds?: number[] }
export interface MajorEventV2 {
  kind: "major_model_release" | "binding_policy" | "major_incident" | "major_platform_change" | "major_industry_change" | "none";
  affectedGroups: string[]; realizedChange: string; evidenceFactIds: number[]; limitations: string | null;
}
export interface TopicMaterialAnalysis {
  gates?: { audience: boolean; evidence: boolean; benefit: boolean };
  materialId: string;
  state: "not_analyzed" | "queued" | "running" | "completed" | "failed";
  receiptId: number | null;
  error: string | null;
  columnId?: string;
  columnSnapshot?: Pick<TopicColumn, "id" | "name" | "version"> | null;
  columnSemanticsKey?: string;
  disposition?: "support" | "background" | "duplicate" | "not_topic" | "pending";
  summary?: string;
  reason?: string;
  viewerBenefit?: string | null;
  insights?: MaterialInsights;
  shared?: {
    policy: string; scope: "direct" | "important_ai" | "unrelated" | "uncertain"; scopeReason: string; scopeQuotes: string[];
    editorialScope?: EditorialScopeV2; aiCentral?: boolean; filmRelevant?: boolean; scopeFactIds?: number[]; aiRole?: string | null;
    facts: Array<{ text: string; quotes: string[] }>;
    publicDimensions: Record<"practical" | "interest" | "substance", { value: number | null; reason: string }>;
    impact?: { value: number | null; reason: string };
    v2?: Record<"I" | "M" | "D" | "P" | "E" | "X", SemanticDimensionV2>;
    majorEvent?: MajorEventV2 | null; publicSummary?: string; titleZh?: string; summaryFactIds?: number[]; primaryIntent?: "practice" | "models" | "news" | "cases" | "other";
    columnMatches: Array<{ columnId: string; value: number; reason: string }>;
    event: { relation: "new" | "same" | "development" | "composite"; candidateId: string | null; label: string; identity: string; quotes: string[]; time?: EventTime | null } | null;
    reportingKind: "original" | "repost" | "commentary" | "test" | "development";
    memeEvidence: Array<{ text: string; quotes: string[] }>;
    memeMetrics?: { participants:number;platforms:number;sources:number;cases:number;originalParticipants:number;derivativeWorks:number;evidenceFactIds:number[] } | null;
    dailyReuse?: { kind: "background" | "policy"; validFrom: string | null; validThrough: string | null; quotes: string[] } | null;
  };
  event?: string | null;
  sharedEventId?: string;
  entities?: MaterialEntity[];
  entityIndex?: { policy: string; indexed: boolean };
  evidenceQuotes?: string[];
  gaps?: string[];
  score?: { total: number; eligible: boolean; policyVersion: string; dimensions: MaterialDimensions; gaps: string[] };
}
export type MaterialAnalysisState = "not_analyzed" | "pending" | "waiting_body" | "queued" | "running" | "completed" | "failed" | "superseded";
export interface MaterialAnalysisReading {
  materialId: string; sourceKey: string | null; state: MaterialAnalysisState;
  result: Omit<TopicMaterialAnalysis, "materialId" | "state" | "receiptId" | "error"> | null;
  receiptId: number | null; error: string | null; modelEnabled: boolean; updatedAt: string | null;
  batchId: string | null; batchOwnsVersion: boolean; origin: "live" | "batch" | null;
  classification?: { key: string; state: MaterialAnalysisState; error: string | null; updatedAt: string | null };
}
export interface TopicMaterialAnalysisPage {
  total: number;
  analyzed: number;
  pending: number;
  page: number;
  hasMore: boolean;
  modelEnabled: boolean;
  rows: TopicMaterialAnalysis[];
}

export interface TopicBatchPage {
  rows: TopicBatch[];
  total: number;
  page: number;
  hasMore: boolean;
}

/** Durable pool allocation records; legacy caches and unimported files are outside this scope. */
export interface ImageAssetStatus {
  scope: "managed_image_allocations";
  storedBytes: number;
  pendingBytes: number;
  limitBytes: number;
}

/** Data-volume free space minus temporary reservations; category usage budgets are checked separately. */
export interface DiskResourceStatus {
  scope: "data_volume";
  state: "warming" | "unavailable" | "normal" | "warning" | "limited" | "protected" | "recovering";
  availableBytes: number | null;
  reservedBytes: number | null;
  unreservedBytes: number | null;
  sampleAgeMs: number | null;
  ingestionAllowed: boolean;
  heavyTaskAllowed: boolean;
}

/** Observed files in the configured image roots plus outstanding durable allocations. */
export interface ImageStorageStatus {
  scope: "configured_image_storage";
  state: "normal" | "limited" | "unavailable";
  cacheBytes: number | null;
  assetBytes: number | null;
  usedBytes: number | null;
  limitBytes: number;
}

/** Supervisor-managed service logs; database and independent collectors remain excluded. */
export interface RuntimeLogStatus {
  scope: "api_web" | "api_web_worker";
  state: "normal" | "limited" | "unavailable";
  storedBytes: number | null;
  limitBytes: number;
  droppedRecords: number;
}

/** A point-in-time estimate, not a whole-machine quota or a current CPU utilization rate. */
export type ApplicationResources = { ok: false; state: "unavailable" } | {
  ok: true;
  state: "measured";
  scope: "runtime_and_database_cluster";
  enforcement: "runtime_job_only";
  components: Array<{ role: "runtime" | "launcher" | "job_controller" | "database"; processes: number; privateBytes: number; cpuTimeMs: number }>;
  databaseMainSharedBytes: number;
  memoryEstimateBytes: number;
  unmeasured: ["other_shared_mappings", "database_dynamic_shared_memory", "nginx_and_service_host"];
};

/** Application database plus cluster-shared WAL/temp; not the entire cluster. */
export interface DatabaseResourceStatus {
  scope: "database_with_shared_wal_temp";
  state: "warming" | "normal" | "warning" | "limited" | "recovering" | "unavailable";
  databaseBytes: number | null;
  walBytes: number | null;
  temporaryBytes: number | null;
  usedBytes: number | null;
  limitBytes: number;
  sampleAgeMs: number | null;
  estimatedRemainingSeconds: number | null;
  ingestionAllowed: boolean;
}

/** Host pressure only; ready does not certify the application's aggregate process budget. */
export interface HostResourceStatus {
  scope: "host";
  state: "warming" | "unavailable" | "paused" | "recovering" | "ready";
  reasons: Array<"memory_low" | "cpu_sustained" | "monitor_warming" | "monitor_unavailable" | "monitor_stale" | "recovery_pending" | "monitor_stopped">;
  availableMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  cpuPercent: number | null;
  sampleAgeMs: number | null;
  releaseIdleResources: boolean;
}
export interface MediaProcessingStatus {
  state: "not_queued" | "queued" | "running" | "ready" | "failed";
  enabled: boolean;
  error: string | null;
  updatedAt: string | null;
}

export interface ModelOperations {
  version: number;
  requestedEnabled: boolean;
  runtimeAllowed: boolean;
  enabled: boolean;
  updatedAt: string | null;
}
export const STUDIO_MODEL = "deepseek-flash";
export interface ModelBudgetSettings { version: number; perDay: number; perMonth: number; updatedAt: string | null; currency: "CNY"; timeZone: "Asia/Hong_Kong";
  hardLimitEnabled: boolean; warningPerDay: number; warningPerMonth: number }
export interface CollectionOperations { media?:Omit<CollectionOperations,"media">; version: number | null; requestedEnabled: boolean | null; runtimeAllowed: boolean; enabled: boolean; state: "ready" | "unavailable"; updatedAt: string | null }
export interface RuntimeComponents { checkedAt: string; check: "local_files"; rows: Array<{ id: string; name: string; state: "files_present" | "missing" | "configured" | "invalid" | "not_configured"; detail: string }> }
export interface StudioBackupStatus { configured: boolean; externalDeclared: boolean; protected: boolean; state: "not_started" | "queued" | "running" | "completed" | "failed";
  last: { id: string; at: string; bytes: number; files: number; externalDeclared: boolean } | null; error: string | null }

export interface ModelConnection {
  environmentConfigured?: boolean;
  visionModel?: string | null;
  visionPrice?: { inputPerMillion: number; outputPerMillion: number } | null;
  version: number;
  baseUrl: string;
  analysisModel: string;
  qualityModel: string;
  state: "missing" | "saved" | "unreadable";
  verified: false;
  runtimeEnabled: boolean;
  updatedAt: string | null;
  analysisPrice: { inputPerMillion: number; outputPerMillion: number } | null;
  qualityPrice: { inputPerMillion: number; outputPerMillion: number } | null;
}

export interface DailyEditionPage {
  rows: Array<{ day: string; state: "pending" | "queued" | "fallback" | "completed" | "failed"; error: string | null; attempt: number;
    windowStart: string; windowEnd: string; count: number; revision: number | null }>;
  modelEnabled: boolean;
}

export interface ModelUsage {
  currency: "CNY";
  timeZone: "Asia/Hong_Kong";
  day: string;
  month: string;
  budget: { perDay: number; perMonth: number; spentToday: number; spentThisMonth: number; remainingToday: number; remainingThisMonth: number;
    hardLimitEnabled: boolean; warningPerDay: number; warningPerMonth: number; warningToday: boolean; warningThisMonth: boolean };
  concurrency: { limit: number; occupied: number };
  modelEnabled: boolean;
  tasks: { queued: number; active: number };
  rows: Array<{ key: string; label: string; attemptsThisMonth: number; inputTokensThisMonth: number; outputTokensThisMonth: number;
    missingUsageAttempts: number; unknownAttempts: number; estimatedToday: number; estimatedThisMonth: number; reservedToday: number; reservedThisMonth: number }>;
}
