import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { test } from "node:test";
import { runWindowsProcessGroup } from "../backend/windows-process-group.ts";

test("Windows任务在开始执行前进入内核资源组，并报告实际整组额度", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-test-"));
  const output = path.join(folder, "结果 with spaces.json");
  const statuses: { activeProcesses: number; cpuPercent: number; memoryLimitBytes: number }[] = [];
  try {
    const result = await runWindowsProcessGroup({ executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))", output, '中文 "引号"', "ends\\"],
      cwd: folder, cpuPercent: 25, memoryLimitBytes: 512 * 1024 ** 2,
      onStatus: value => { statuses.push(value); } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ['中文 "引号"', "ends\\"]);
    assert.ok(statuses.some(value => value.activeProcesses >= 1));
    assert.ok(statuses.every(value => value.cpuPercent === 25 && value.memoryLimitBytes === 536870912));
    assert.ok(result.peakMemoryBytes > 0);
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("启动准备期间取消，不执行已经失去宿主授权的任务正文", { timeout: 15_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-start-cancel-")), output = path.join(folder, "must-not-execute.txt");
  const controller = new AbortController();
  try {
    const running = runWindowsProcessGroup({ executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'executed')", output], cwd: folder,
      cpuPercent: 25, memoryLimitBytes: 512 * 1024 ** 2, signal: controller.signal,
      onStatus: () => {
        // Admission may be slow; the suspended root must not execute before this returns.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        controller.abort(new Error("cancelled during preparation"));
      } });
    await assert.rejects(running, /cancelled during preparation/);
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("内核内存限额覆盖父子进程之和，子进程不能再取得一份完整额度", { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-memory-"));
  const probe = path.join(folder, "memory.ps1"), output = path.join(folder, "allocation.txt");
  try {
    await writeFile(probe, `$ErrorActionPreference = 'Stop'
      Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class MemoryProbe{
      [DllImport("kernel32.dll")]public static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr bytes,uint type,uint protect);
      public static bool Allocate(){return VirtualAlloc(IntPtr.Zero,new UIntPtr(33554432u),0x3000,4)!=IntPtr.Zero;}}'
      $allocated = 0
      for ($i = 0; $i -lt 6; $i++) { if (-not [MemoryProbe]::Allocate()) { break }; $allocated += 33554432 }
      [IO.File]::WriteAllText($args[0],[string]$allocated)
    `);
    const result = await runWindowsProcessGroup({ executable: process.execPath,
      args: ["-e", `const held=Buffer.alloc(96*1024**2,1);const child=require('node:child_process').spawnSync(
        process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.argv[1],process.argv[2]],{windowsHide:true,stdio:'ignore'});
        if(held[0]!==1||child.status!==0)process.exit(1);`, probe, output],
      cwd: folder, cpuPercent: 25, memoryLimitBytes: 256 * 1024 ** 2 });
    assert.equal(result.exitCode, 0);
    const allocated = Number(await readFile(output, "utf8"));
    assert.ok(allocated > 0 && allocated < 192 * 1024 ** 2, `child allocation must stop below 192MiB, actual=${allocated}, peak=${result.peakMemoryBytes}`);
    const control = await runWindowsProcessGroup({ executable: path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe, output],
      cwd: folder, cpuPercent: 25, memoryLimitBytes: 512 * 1024 ** 2 });
    assert.equal(control.exitCode, 0);
    assert.equal(Number(await readFile(output, "utf8")), 192 * 1024 ** 2, "probe can allocate the full amount without parent contention");
    assert.ok(result.peakMemoryBytes > 0, "raw kernel peak is diagnostic, not an assertion about physical RSS");
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("根任务正常退出时回收仍在运行的后代，保留根任务退出码", { timeout: 15_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-exit-")), pids = path.join(folder, "pids.json");
  try {
    const result = await runWindowsProcessGroup({ executable: process.execPath,
      args: ["-e", `const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore',windowsHide:true});
        require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));child.unref();process.exitCode=7;`, pids],
      cwd: folder, cpuPercent: 25, memoryLimitBytes: 512 * 1024 ** 2 });
    assert.equal(result.exitCode, 7);
    for (const pid of JSON.parse(await readFile(pids, "utf8"))) assert.throws(() => process.kill(pid, 0));
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("Node宿主突然退出后，资源组不会留下后台任务", { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-owner-")), pids = path.join(folder, "pids.json");
  const moduleUrl = new URL("../backend/windows-process-group.ts", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `import {runWindowsProcessGroup} from ${JSON.stringify(moduleUrl)};
    const fs=await import('node:fs');
    await runWindowsProcessGroup({executable:process.execPath,args:['-e',"setTimeout(()=>{},12000)"],cwd:process.cwd(),cpuPercent:25,memoryLimitBytes:536870912,
      onStatus:status=>{if(status.activeProcesses>0)fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,status.rootProcessId]))}});`, pids],
    { windowsHide: true, stdio: "ignore" });
  try {
    const deadline = Date.now() + 8000;
    let owned: number[] | undefined;
    while (Date.now() < deadline) {
      try { owned = JSON.parse(await readFile(pids, "utf8")); break; } catch { await delay(50); }
    }
    assert.ok(owned, "owner must publish a live owned process before crash");
    owner.kill();
    let gone = false;
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(owned[1]!, 0); await delay(50); } catch { gone = true; break; }
    }
    assert.equal(gone, true);
  } finally {
    if (owner.exitCode === null) owner.kill();
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("额度无效或超过4核8GB设计上限时拒绝启动，不能退回无约束进程", { timeout: 15_000 }, async () => {
  for (const limits of [{ cpuPercent: 76, memoryLimitBytes: 536870912 }, { cpuPercent: 0, memoryLimitBytes: 536870912 },
    { cpuPercent: 25.5, memoryLimitBytes: 536870912 }, { cpuPercent: 25, memoryLimitBytes: 7 * 1024 ** 3 },
    { cpuPercent: 25, memoryLimitBytes: 0 }, { cpuPercent: 25, memoryLimitBytes: Number.NaN }]) {
    await assert.rejects(runWindowsProcessGroup({ executable: process.execPath, args: ["-e", ""], cwd: process.cwd(), ...limits }), /资源额度无效/);
  }
});

test("原生进程创建失败时安全报错，不回显参数中的敏感内容", { timeout: 15_000 }, async () => {
  await assert.rejects(runWindowsProcessGroup({ executable: path.resolve(".local/nonexistent-private-program.exe"),
    args: ["fixture-private-value"], cwd: process.cwd(), cpuPercent: 25, memoryLimitBytes: 536870912 }),
  error => error instanceof Error && error.message === "Windows资源组运行失败，未使用无约束模式重试");
});

test("跨进程监测报文缺字段时拒绝准入，不能将残缺结果标成成功", { timeout: 15_000 }, async t => {
  const launch = childProcess.spawn;
  // Fault at the OS process/stdio boundary, not at an internal helper; the other tests use real Jobs.
  t.mock.method(childProcess, "spawn", (_file: string, _args: string[], options: childProcess.SpawnOptions) => launch(process.execPath, ["-e", `
    let input='';let configured=false;process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);
      if(!configured){configured=true;console.log('{"type":"status"}');}
      else if(line==='start'){console.log('{"type":"result"}');process.exit(0);}}});
    process.stdin.on('end',()=>process.exit(0));
  `], options));
  syncBuiltinESMExports();
  try {
    await assert.rejects(runWindowsProcessGroup({ executable: process.execPath, args: ["-e", ""], cwd: process.cwd(),
      cpuPercent: 25, memoryLimitBytes: 536870912 }), /资源组运行失败/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("控制器不响应取消时有界结束，并明确报告无法确认回收", { timeout: 15_000 }, async t => {
  const launch = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (_file: string, _args: string[], options: childProcess.SpawnOptions) => launch(process.execPath,
    ["-e", "process.stdin.resume();process.stdin.on('end',()=>{});setTimeout(()=>{},8000)"], options));
  syncBuiltinESMExports();
  const started = Date.now();
  try {
    await assert.rejects(runWindowsProcessGroup({ executable: process.execPath, args: ["-e", ""], cwd: process.cwd(),
      cpuPercent: 25, memoryLimitBytes: 536870912, signal: AbortSignal.timeout(50) }), /无法确认资源组退出/);
    assert.ok(Date.now() - started < 6500);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("取消任务等待整组子孙退出，且不影响组外的其他进程", { timeout: 15_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/job-cancel-"));
  const pids = path.join(folder, "owned.json");
  const controller = new AbortController();
  const outside = spawn(process.execPath, ["-e", "setTimeout(()=>{},12000)"], { windowsHide: true, stdio: "ignore" });
  try {
    await assert.rejects(runWindowsProcessGroup({ executable: process.execPath,
      args: ["-e", `const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore',windowsHide:true});
        const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify([process.pid,child.pid]));
        fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);child.unref();setTimeout(()=>{},3000);`, pids],
      cwd: folder, cpuPercent: 25, memoryLimitBytes: 512 * 1024 ** 2, signal: controller.signal,
      // The kernel can report the child between spawn and the parent's next write.
      // Cancel only after the owned PID list is atomically published for exit assertions.
      onStatus: status => { if (status.activeProcesses >= 2 && existsSync(pids)) controller.abort(new Error("fixture cancellation")); } }), /fixture cancellation/);
    for (const pid of JSON.parse(await readFile(pids, "utf8"))) assert.throws(() => process.kill(pid, 0));
    assert.equal(outside.exitCode, null);
    assert.doesNotThrow(() => process.kill(outside.pid!, 0));
  } finally {
    outside.kill();
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});
