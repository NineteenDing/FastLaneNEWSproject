import { cpus, freemem, totalmem } from "node:os";
import type { HostResourceStatus } from "../contracts.ts";

export interface HostCounters {
  availableMemoryBytes: number;
  totalMemoryBytes: number;
  cpus: Array<{ idle: number; total: number }>;
}

const GiB = 1024 ** 3;
function validCounters(value: HostCounters): boolean {
  return !!value && Number.isSafeInteger(value.availableMemoryBytes) && value.availableMemoryBytes >= 0
    && Number.isSafeInteger(value.totalMemoryBytes) && value.totalMemoryBytes > 0 && value.availableMemoryBytes <= value.totalMemoryBytes
    && Array.isArray(value.cpus) && value.cpus.length > 0 && value.cpus.every(cpu => cpu
      && Number.isSafeInteger(cpu.idle) && Number.isSafeInteger(cpu.total) && cpu.idle >= 0 && cpu.total >= cpu.idle);
}
function unknownStatus(reason: "monitor_warming" | "monitor_unavailable" | "monitor_stale" | "monitor_stopped"): HostResourceStatus {
  return { scope: "host", state: reason === "monitor_warming" ? "warming" : "unavailable", reasons: [reason],
    availableMemoryBytes: null, totalMemoryBytes: null, cpuPercent: null, sampleAgeMs: null, releaseIdleResources: false };
}
function readHostCounters(): HostCounters {
  return { availableMemoryBytes: freemem(), totalMemoryBytes: totalmem(), cpus: cpus().map(({ times }) => ({
    idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq,
  })) };
}

/** Monitor and clock are OS seams. Heavy-task callers must also check their application/disk budgets. */
export function createHostResourceMonitor(options: { read?: () => HostCounters; now?: () => number } = {}) {
  const read = options.read ?? readHostCounters, now = options.now ?? (() => Math.floor(performance.now()));
  let status = unknownStatus("monitor_warming");
  let previous: { counters: HostCounters; at: number } | undefined;
  let blocked = true, safeSince: number | undefined, highSince: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function view(): HostResourceStatus {
    if (previous) {
      let age: number;
      try { age = now() - previous.at; }
      catch { return unknownStatus("monitor_unavailable"); }
      if (!Number.isSafeInteger(age) || age < 0 || age > 15_000) return unknownStatus("monitor_stale");
      return { ...status, reasons: [...status.reasons], sampleAgeMs: age };
    }
    return { ...status, reasons: [...status.reasons] };
  }
  function stop() {
    clearInterval(timer); timer = undefined;
    status = unknownStatus("monitor_stopped"); previous = undefined;
    blocked = true; safeSince = undefined; highSince = undefined;
  }
  const monitor = {
    sample() {
      let counters: HostCounters, at: number;
      try {
        counters = read(); at = now();
        if (!validCounters(counters) || !Number.isSafeInteger(at) || at < 0) throw new Error();
        counters = { ...counters, cpus: counters.cpus.map(cpu => ({ ...cpu })) };
      } catch {
        status = unknownStatus("monitor_unavailable"); previous = undefined;
        blocked = true; safeSince = undefined; highSince = undefined;
        return;
      }
      const total = counters.cpus.reduce((sum, cpu) => sum + cpu.total, 0);
      const idle = counters.cpus.reduce((sum, cpu) => sum + cpu.idle, 0);
      const oldTotal = previous?.counters.cpus.reduce((sum, cpu) => sum + cpu.total, 0) ?? total;
      const oldIdle = previous?.counters.cpus.reduce((sum, cpu) => sum + cpu.idle, 0) ?? idle;
      const continuous = previous && at > previous.at && at - previous.at <= 15_000
        && previous.counters.cpus.length === counters.cpus.length && counters.cpus.every((cpu, index) => {
          const old = previous!.counters.cpus[index]!;
          return cpu.total >= old.total && cpu.idle >= old.idle && cpu.idle - old.idle <= cpu.total - old.total;
        }) && [total, idle, oldTotal, oldIdle].every(Number.isSafeInteger);
      const cpuPercent = continuous && total > oldTotal ? (1 - (idle - oldIdle) / (total - oldTotal)) * 100 : null;
      if (cpuPercent !== null && cpuPercent > 75) highSince ??= previous!.at;
      else highSince = undefined;
      previous = { counters, at };
      status = { ...status, cpuPercent, state: "ready", reasons: [],
        availableMemoryBytes: counters.availableMemoryBytes, totalMemoryBytes: counters.totalMemoryBytes,
        sampleAgeMs: 0, releaseIdleResources: counters.availableMemoryBytes < GiB };
      if (counters.availableMemoryBytes < 1.5 * GiB || (highSince !== undefined && at - highSince >= 300_000)) {
        blocked = true; safeSince = undefined; status.state = "paused";
        if (counters.availableMemoryBytes < 1.5 * GiB) status.reasons.push("memory_low");
        if (highSince !== undefined && at - highSince >= 300_000) status.reasons.push("cpu_sustained");
      } else if (cpuPercent === null) {
        blocked = true; safeSince = undefined; status.state = "warming"; status.reasons = ["monitor_warming"];
      } else if (blocked) {
        status.reasons = ["recovery_pending"];
        if (counters.availableMemoryBytes >= 2 * GiB && cpuPercent <= 65) {
          safeSince ??= at;
          if (at - safeSince >= 60_000) { blocked = false; status.reasons = []; }
          else status.state = "recovering";
        } else { safeSince = undefined; status.state = "paused"; }
      }
    },
    status: view,
    assertHeavyTaskAllowed() { if (view().state !== "ready") throw new Error("主机资源暂不允许启动新重任务"); },
    start() {
      if (!timer) {
        monitor.sample();
        timer = setInterval(() => monitor.sample(), 5000);
        timer.unref();
      }
      return stop;
    },
  };
  return monitor;
}
