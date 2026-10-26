import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHostResourceMonitor } from "../backend/host-resources.ts";

const GiB = 1024 ** 3;

test("真实Windows主机按后台计时采样且停止后不再报告可放行", { timeout: 10_000 }, async () => {
  const monitor = createHostResourceMonitor();
  const stop = monitor.start();
  try {
    const first = monitor.status();
    assert.equal(first.scope, "host");
    assert.equal(first.cpuPercent, null, "首次无CPU时间差不能显示0%冒充空闲");
    assert.ok(first.totalMemoryBytes! > 0 && first.availableMemoryBytes! >= 0);
    await delay(5200);
    const measured = monitor.status();
    assert.ok(measured.cpuPercent !== null && measured.cpuPercent >= 0 && measured.cpuPercent <= 100);
    assert.ok(measured.sampleAgeMs! < 2000);
  } finally { stop(); }
  assert.deepEqual(monitor.status().reasons, ["monitor_stopped"]);
  assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
});

test("内存或CPU监测异常不能被当成资源充足，读取失败不向状态泄露异常细节", () => {
  const invalid = [
    { availableMemoryBytes: NaN }, { availableMemoryBytes: Infinity }, { availableMemoryBytes: -1 },
    { availableMemoryBytes: 9 * GiB }, { availableMemoryBytes: 1.5 }, { totalMemoryBytes: 0 },
    { cpus: [] }, { cpus: [{ idle: -1, total: 10 }] }, { cpus: [{ idle: 11, total: 10 }] },
    { cpus: [{ idle: 1, total: Infinity }] },
  ];
  for (const value of invalid) {
    const monitor = createHostResourceMonitor({ read: () => ({ availableMemoryBytes: 4 * GiB, totalMemoryBytes: 8 * GiB,
      cpus: [{ idle: 100, total: 200 }], ...value }) });
    assert.doesNotThrow(() => monitor.sample());
    assert.equal(monitor.status().state, "unavailable", JSON.stringify(value));
    assert.equal(monitor.status().availableMemoryBytes, null);
    assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
  }
  const monitor = createHostResourceMonitor({ read: () => { throw new Error("private-path-or-token"); } });
  assert.doesNotThrow(() => monitor.sample());
  assert.deepEqual(monitor.status().reasons, ["monitor_unavailable"]);
  assert.ok(!JSON.stringify(monitor.status()).includes("private-path-or-token"));
});

test("CPU数量变化、单核计数回退及无效时间不能维持原来的放行状态", () => {
  for (const failure of ["topology", "counter", "clock-backwards", "clock-throws"] as const) {
    let now = 0, changed = false;
    const monitor = createHostResourceMonitor({ now: () => {
      if (changed && failure === "clock-throws") throw new Error("clock-failed");
      return now;
    }, read: () => ({ availableMemoryBytes: 4 * GiB, totalMemoryBytes: 8 * GiB,
      cpus: changed && failure === "topology" ? [{ idle: now, total: now * 2 }]
        : changed && failure === "counter" ? [{ idle: 0, total: 0 }, { idle: now, total: now * 10 }]
        : [{ idle: now, total: now * 2 }, { idle: now, total: now * 2 }] }) });
    monitor.sample();
    for (let n = 0; n < 13; n++) { now += 5000; monitor.sample(); }
    assert.equal(monitor.status().state, "ready");
    changed = true;
    now += failure === "clock-backwards" ? -5000 : 5000;
    if (failure === "clock-throws") assert.doesNotThrow(() => monitor.status());
    assert.doesNotThrow(() => monitor.sample());
    assert.notEqual(monitor.status().state, "ready", failure);
    assert.equal(monitor.status().cpuPercent, null);
    assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
  }
});

test("停止采样超过15秒即拒绝新任务，网页反复读取不能续期或补齐CPU观察时间", () => {
  let now = 0, reads = 0;
  const monitor = createHostResourceMonitor({ now: () => now, read: () => {
    reads++; return { availableMemoryBytes: 4 * GiB, totalMemoryBytes: 8 * GiB, cpus: [{ idle: now, total: now * 2 }] };
  } });
  monitor.sample();
  for (let n = 0; n < 13; n++) { now += 5000; monitor.sample(); }
  assert.equal(monitor.status().state, "ready");
  const sampled = reads;
  now += 15001;
  for (let n = 0; n < 5; n++) {
    assert.equal(monitor.status().state, "unavailable");
    assert.deepEqual(monitor.status().reasons, ["monitor_stale"]);
    assert.equal(monitor.status().cpuPercent, null);
    assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
  }
  assert.equal(reads, sampled);
  monitor.sample();
  assert.equal(monitor.status().state, "warming");
  for (let n = 0; n < 12; n++) { now += 5000; monitor.sample(); }
  assert.equal(monitor.status().state, "recovering");
  now += 5000; monitor.sample();
  assert.equal(monitor.status().state, "ready");
});

test("主机可用内存不足时拒绝新重任务，低于1GiB还要求释放空闲资源", () => {
  let free = GiB, now = 0;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => ({ availableMemoryBytes: free, totalMemoryBytes: 8 * GiB, cpus: [{ idle: now, total: now * 2 }] }) });
  monitor.sample();
  assert.equal(monitor.status().state, "paused");
  assert.ok(monitor.status().reasons.includes("memory_low"));
  assert.equal(monitor.status().releaseIdleResources, false);
  assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
  now = 5000; free = GiB - 1; monitor.sample();
  assert.equal(monitor.status().releaseIdleResources, true);
  assert.equal(monitor.status().availableMemoryBytes, 1073741823);
});

test("CPU超过75%需连续观察满5分钟才暂停，75%或以下会打断累计", () => {
  let now = 0, total = 1000, idle = 500;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => ({ availableMemoryBytes: 4 * GiB, totalMemoryBytes: 8 * GiB, cpus: [{ idle, total }] }) });
  const step = (busy: number) => {
    now += 5000; total += 10000; idle += (100 - busy) * 100;
    monitor.sample(); return monitor.status();
  };
  monitor.sample();
  for (let n = 0; n < 13; n++) step(50);
  assert.equal(monitor.status().state, "ready");
  for (let n = 0; n < 59; n++) assert.equal(step(80).state, "ready");
  assert.equal(step(75).state, "ready");
  for (let n = 0; n < 59; n++) assert.equal(step(80).state, "ready");
  assert.equal(step(80).state, "paused");
  assert.deepEqual(monitor.status().reasons, ["cpu_sustained"]);
  assert.throws(() => monitor.assertHeavyTaskAllowed(), /主机资源/);
  assert.equal(step(65).state, "recovering");
});

test("压力解除后需连续60秒处于至少2GiB和至多65%CPU的安全区，波动会重新计时", () => {
  let free = GiB, now = 0, total = 1000, idle = 500;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => ({ availableMemoryBytes: free, totalMemoryBytes: 8 * GiB, cpus: [{ idle, total }] }) });
  const step = (memory: number, busy = 50) => {
    now += 5000; total += 10000; idle += (100 - busy) * 100;
    free = memory; monitor.sample(); return monitor.status();
  };
  monitor.sample();
  assert.equal(step(2 * GiB).state, "recovering");
  for (let n = 0; n < 11; n++) assert.equal(step(2 * GiB).state, "recovering");
  assert.equal(step(1.75 * GiB).state, "paused");
  assert.equal(step(2 * GiB).state, "recovering");
  for (let n = 0; n < 11; n++) step(2 * GiB);
  assert.equal(step(2 * GiB).state, "ready");
  assert.equal(monitor.status().cpuPercent, 50);
  assert.doesNotThrow(() => monitor.assertHeavyTaskAllowed());
});
