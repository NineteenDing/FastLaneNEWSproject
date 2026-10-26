// Shared deterministic heat mapping for editorial-v2. No state, database or model access.
export type HeatAnchors = ReadonlyArray<readonly [number, number]>;

export const REPORTER_ANCHORS: HeatAnchors = [[0, 0], [1, 15], [3, 40], [5, 60], [10, 85], [20, 95]];
export const VIDEO_ANCHORS: HeatAnchors = [[0, 0], [10000, 10], [100000, 40], [500000, 70], [1000000, 85], [5000000, 95]];

export function interpolateValue(x: number, knots: HeatAnchors, logarithmic = false): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const last = knots[knots.length - 1]!;
  if (x > last[0]) return 100 - (100 - last[1]) * last[0] / x;
  for (let index = 1; index < knots.length; index++) {
    const [a, u] = knots[index - 1]!, [b, v] = knots[index]!;
    if (x <= b) {
      const f = logarithmic ? Math.log1p : (n: number) => n;
      return u + (v - u) * (f(x) - f(a)) / (f(b) - f(a));
    }
  }
  return last[1];
}

export const reporterHeatValue = (effective: number) => interpolateValue(effective, REPORTER_ANCHORS);
export const videoHeatValue = (effective: number) => interpolateValue(effective, VIDEO_ANCHORS, true);
