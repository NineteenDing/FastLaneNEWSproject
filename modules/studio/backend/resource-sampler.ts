/** Shared lifecycle only; each resource retains its own readings, validity and policy. */
export function createResourceSampler(options: {
  intervalMs: number;
  sample: (current: () => boolean) => Promise<void>;
  invalidate: () => void;
}) {
  let pending: Promise<void> | undefined, generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  function sample(): Promise<void> {
    if (pending) return pending;
    const owner = generation;
    pending = Promise.resolve().then(() => options.sample(() => owner === generation))
      .finally(() => { pending = undefined; });
    return pending;
  }
  function stop() {
    clearInterval(timer); timer = undefined; generation++; options.invalidate();
  }
  return {
    sample,
    start() {
      if (!timer) {
        void sample();
        timer = setInterval(() => { void sample(); }, options.intervalMs);
        timer.unref();
      }
      return stop;
    },
  };
}
