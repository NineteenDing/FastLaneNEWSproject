import type { EditorialPolicyV2, EventHeat, EventObservation, EventPropagationRules, EventTime, FilterPolicy } from "../contracts.ts";
import { heatSnapshot, interpolate, type HeatSnapshotV2, type ObservationState } from "./editorial-v2.ts";

export const defaultEventPropagationRules: EventPropagationRules = {
  windowHours: 48, independentReports: 10, observedViews: 1000000, independentAuthors: 3, allowMeme: true,
};
export type PropagationRow = { materialId: string; participant: string; reportingKind: string; scope: string;
  platform: string; kind: string; work: string; views: number | null; hasMemeEvidence: boolean; verifiedMeme?: boolean; publishedAt?: string; observedAt?: string | null };

function platformWorks(rows: PropagationRow[]) {
  return [...new Set(rows.filter(row => row.kind === "video").map(row => row.platform))].sort().map(platform => {
    const publications = rows.filter(row => row.kind === "video" && row.platform === platform), works = new Map<string, PropagationRow>();
    for (const row of publications) {
      const prior = works.get(row.work);
      if (!prior || (row.views ?? -1) > (prior.views ?? -1)) works.set(row.work, row);
    }
    const known = [...works.values()].filter(row => row.views !== null && Number.isFinite(row.views) && row.views >= 0);
    return { platform, publications, works, known };
  });
}

/** Prefer current original evidence over stale reprints. Contradictory original dates remain unknown. */
export function resolveEventTime(reports: Array<{ reportingKind: string; time?: EventTime | null }>): EventTime | null {
  const known = reports.filter(report => report.time), original = known.filter(report => ["original", "test", "development"].includes(report.reportingKind));
  const candidates = original.length ? original : known;
  if (!candidates.length) return null;
  const intervals = candidates.map(report => { const start = Date.parse(report.time!.at); return { report, start,
    end: start + (report.time!.precision === "day" ? 86400000 - 1 : 0) }; });
  if (intervals.some(value => !Number.isFinite(value.start)) || Math.max(...intervals.map(value => value.start)) > Math.min(...intervals.map(value => value.end))) return null;
  return (candidates.find(report => report.time!.precision === "instant") ?? candidates[0])!.time!;
}

/** Adapted from AIHOT independent-participant half-life and TopicEye decay. Never sum platform counters. */
export function eventHeat(rows: PropagationRow[], asOf: string, policy: FilterPolicy["heat"]): EventHeat {
  const cutoff = Date.parse(asOf);
  const decay = (row: PropagationRow) => row.publishedAt && Number.isFinite(Date.parse(row.publishedAt)) && Date.parse(row.publishedAt) <= cutoff
    ? Math.pow(2, -(cutoff - Date.parse(row.publishedAt)) / (policy.halfLifeHours * 3600000)) : 0;
  const band = (value: number, bands: FilterPolicy["heat"]["reporterBands"]) => bands.filter(row => value >= row.at).at(-1)?.value ?? 0;
  const reporters = new Map<string, number>();
  for (const row of rows.filter(row => row.reportingKind !== "commentary")) reporters.set(row.participant, Math.max(reporters.get(row.participant) ?? 0, decay(row)));
  const reporterScore = reporters.size ? band(reporters.size, policy.reporterBands) * [...reporters.values()].reduce((sum, value) => sum + value, 0) / reporters.size : 0;
  const platformScores = platformWorks(rows).map(({ platform, known }) => {
    const views = known.reduce((sum, row) => sum + row.views!, 0);
    return { platform, value: known.length ? (views ? band(views, policy.videoBands) * known.reduce((sum, row) => sum + row.views! * decay(row), 0) / views : 0) : null };
  });
  return { value: Math.max(reporterScore, ...platformScores.map(row => row.value ?? 0)), reporterScore, platformScores, halfLifeHours: policy.halfLifeHours };
}

/**
 * Editorial-v2 heat: continuous anchors over de-duplicated, decayed effective contributions.
 * H_observed may include stale-but-recent channels; H_fresh only freshly observed channels and drives hot/headline.
 * Trends are not linked to shared events yet, so the channel stays not_supported rather than a fake zero.
 */
export function eventHeatV2(rows: PropagationRow[], asOf: string, policy: EditorialPolicyV2): HeatSnapshotV2 {
  const config = policy.heat, at = Date.parse(asOf), freshMs = policy.breakout.freshHours * 3_600_000;
  const decay = (time: string | undefined | null) => {
    const parsed = time ? Date.parse(time) : NaN;
    return Number.isFinite(parsed) && parsed <= at ? Math.pow(2, -(at - parsed) / (config.halfLifeHours * 3_600_000)) : 0;
  };
  const isFresh = (time: string | undefined | null) => {
    const parsed = time ? Date.parse(time) : NaN;
    return Number.isFinite(parsed) && at - parsed >= 0 && at - parsed <= freshMs;
  };
  const reports = new Map<string, { publishedAt?: string; observedAt?: string | null }>();
  for (const row of rows) {
    const prior = reports.get(row.participant);
    if (!prior || (Date.parse(row.publishedAt ?? "") || 0) > (Date.parse(prior.publishedAt ?? "") || 0))
      reports.set(row.participant, { publishedAt: row.publishedAt, observedAt: row.observedAt });
  }
  const reporterEffective = [...reports.values()].reduce((sum, row) => sum + decay(row.publishedAt), 0);
  // Reports inside the verified 48h window are the report channel's current observation.
  const freshReporterEffective = reporterEffective, freshParticipants = reports.size;
  const reportsValue = rows.length ? interpolate(reporterEffective, config.reporterAnchors) : null;
  const reportsFresh = rows.length && freshParticipants ? interpolate(freshReporterEffective, config.reporterAnchors) : null;

  const video: HeatSnapshotV2["channels"]["video"] = [];
  const platforms = [...new Set(rows.filter(row => row.kind === "video").map(row => row.platform))].sort();
  for (const platform of platforms) {
    const works = new Map<string, { views: number; publishedAt?: string; observedAt?: string | null }>();
    for (const row of rows.filter(candidate => candidate.kind === "video" && candidate.platform === platform)) {
      const views = row.views;
      if (views === null || !Number.isFinite(views) || views < 0) continue;
      const prior = works.get(row.work);
      // Each post contributes its latest valid snapshot; a work seen on several posts keeps the larger latest value.
      if (!prior || views > prior.views || views === prior.views && (Date.parse(row.observedAt ?? "") || 0) > (Date.parse(prior.observedAt ?? "") || 0))
        works.set(row.work, { views, publishedAt: row.publishedAt, observedAt: row.observedAt });
    }
    if (!works.size) { video.push({ platform, value: null, effective: 0, freshValue: null, freshEffective: 0, works: 0, authors: 0, freshAuthors: 0 }); continue; }
    const entries = [...works.values()];
    const effective = entries.reduce((sum, row) => sum + row.views * decay(row.publishedAt), 0);
    const freshEntries = entries.filter(row => isFresh(row.observedAt));
    const freshEffective = freshEntries.reduce((sum, row) => sum + row.views * decay(row.publishedAt), 0);
    const authors = new Set(rows.filter(row => row.kind === "video" && row.platform === platform).map(row => row.participant)).size;
    const freshAuthors = new Set(rows.filter(row => row.kind === "video" && row.platform === platform && isFresh(row.observedAt)).map(row => row.participant)).size;
    video.push({ platform, value: interpolate(effective, config.videoAnchors, true), effective,
      freshValue: freshEntries.length ? interpolate(freshEffective, config.videoAnchors, true) : null, freshEffective, works: works.size, authors, freshAuthors });
  }

  const observedCandidates = [reportsValue, ...video.map(channel => channel.value)].filter((value): value is number => value !== null);
  const freshCandidates = [reportsFresh, ...video.map(channel => channel.freshValue)].filter((value): value is number => value !== null);
  const observed = observedCandidates.length ? Math.max(...observedCandidates) : null;
  const fresh = freshCandidates.length ? Math.max(...freshCandidates) : null;
  // Only metric channels can be stale; report rows are already bounded by the verified window.
  const stale = rows.some(row => row.kind === "video" && !isFresh(row.observedAt));
  const missingReasons = [
    ...(observed === null ? ["no_valid_observation"] : []),
    ...(stale ? ["observation_stale"] : []),
    ...(observed !== null && fresh === null ? ["no_fresh_channel"] : []),
    "unmeasured_video_and_platform_coverage",
  ];
  const state: ObservationState = observed === null ? "unknown" : "partial";
  return heatSnapshot({
    canonicalEventId: "", asOf, observationScope: "public", state, observed, freshObserved: fresh, missingReasons,
    channels: { reports: { value: reportsValue, participants: reports.size, effective: reporterEffective,
      freshValue: reportsFresh, freshParticipants, freshEffective: freshReporterEffective }, video, trends: [] },
  }, policy);
}

/** One observed event, one platform at a time. Callers supply the actual window's evidence. */
export function observeEvent(rows: PropagationRow[], qualified: boolean, asOf: string, rules = defaultEventPropagationRules, freshHours = 6): EventObservation {
  const reports = rows.filter(row => row.reportingKind !== "commentary");
  const independentReporters = new Set(reports.map(row => row.participant)).size;
  const reasons = independentReporters >= rules.independentReports ? ["independent_reports"] : [];
  if (rules.allowMeme && rows.some(row => row.verifiedMeme === true && ["direct", "important_ai"].includes(row.scope))) reasons.push("grounded_meme");
  const platforms = platformWorks(rows).map(({ platform, publications, works, known }) => {
    const fresh = known.filter(row => { const age = Date.parse(asOf) - Date.parse(row.observedAt ?? ""); return age >= 0 && age <= freshHours * 3600000; });
    const freshViews = fresh.reduce((sum, row) => sum + row.views!, 0), freshAuthors = new Set(fresh.map(row => row.participant)).size;
    const observedViews = known.length ? known.reduce((sum, row) => sum + row.views!, 0) : null;
    const independentAuthors = new Set(known.map(row => row.participant)).size;
    if (freshViews >= rules.observedViews && freshAuthors >= rules.independentAuthors) reasons.push("observed_video_views:" + platform);
    return { platform, observedViews, independentAuthors, workCount: works.size, measuredWorkCount: known.length, publicationCount: publications.length };
  });
  return { propagation: { windowHours: rules.windowHours, startsAt: new Date(Date.parse(asOf) - rules.windowHours * 3600000).toISOString(), asOf,
    mentionCount: rows.length, reportCount: reports.length, independentReporters, independentParticipants: new Set(rows.map(row => row.participant)).size,
    independentOriginalReporters: new Set(reports.filter(row => ["original", "test"].includes(row.reportingKind)).map(row => row.participant)).size, platforms },
    breakout: { triggered: qualified && reasons.length > 0, reasons, candidate: qualified && reasons.length > 0 } };
}
