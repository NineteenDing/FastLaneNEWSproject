import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { installRsshub } from "../backend/rsshub-install.ts";
import { readRsshub } from "../backend/rsshub-client.ts";
import { windowsDeletePermissionScript } from "../../../tests/windows-delete-permission.ts";

async function fixture(version = "10.34.6") {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/rsshub-install-test-"));
  const source = path.join(folder, "source"), target = path.join(folder, "installed"), store = path.join(folder, "store");
  const files: Record<string, string> = { "LICENSE": "fixture license\n", "README.md": "fixture source\n",
    "dist/index.mjs": "export default {fetch:()=>new Response('fixture')};\n", "patches/fixture.patch": "fixture\n", "public/health.txt": "ok\n",
    "package.json": JSON.stringify({ name: "rsshub-install-fixture", type: "module", scripts: { prepare: "node forbidden-script.mjs" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
  for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), value); }
  // Fixture approval is created before any tamper; verification itself has independent literal cases.
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(name + "\0" + createHash("sha256").update(files[name]!).digest("hex") + "\n");
  const manifest = { schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 7,
    bytes: Object.values(files).reduce((n, value) => n + Buffer.byteLength(value), 0), sha256: hash.digest("hex") };
  const pnpmCli = path.join(folder, "pnpm.cjs");
  await writeFile(pnpmCli, `if(process.argv.includes('--version'))console.log('${version}');else throw Error('unexpected install');`);
  const options = { sourceDirectory: source, targetDirectory: target, storeDirectory: store, pnpmCli, manifest, offline: true };
  return { folder, source, target, store, pnpmCli, manifest, options, async cleanup() {
    assert.ok(path.resolve(folder).startsWith(path.resolve(".local") + path.sep)); await rm(folder, { recursive: true, force: true });
  } };
}

test("安装器拒绝其他pnpm版本，不能使用开发机碰巧存在的全局工具", async () => {
  const f = await fixture("11.9.0");
  try {
    await assert.rejects(installRsshub(f.options), /固定pnpm版本/);
    await assert.rejects(access(f.target));
    assert.equal((await readdir(f.source)).length, 7);
  } finally { await f.cleanup(); }
});

test("安装器仅复制批准构建，在独立目录按固定锁安装生产依赖且不继承原凭据和脚本设置", async () => {
  const f = await fixture();
  const oldConfig = process.env.npm_config_userconfig;
  process.env.npm_config_userconfig = "private-config-must-not-propagate";
  try {
    await mkdir(path.join(f.source, "node_modules"));
    await writeFile(path.join(f.source, "node_modules/old-install.txt"), "must not copy");
    await writeFile(f.pnpmCli, `const fs=require('node:fs');
      if(process.argv.includes('--version'))console.log('10.34.6');else {
        for(const flag of ['install','--prod','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--ignore-workspace','--offline'])
          if(!process.argv.includes(flag))throw Error('missing safe install flag');
        if(process.env.npm_config_userconfig)throw Error('inherited private npm config');
        fs.mkdirSync('node_modules/fixture-provider',{recursive:true});
        fs.writeFileSync('node_modules/fixture-provider/installed.txt','installed from provider');
      }`);
    const result = await installRsshub(f.options);
    assert.equal(result.dependencies, "installed_from_lock");
    assert.equal(await readFile(path.join(f.target, "node_modules/fixture-provider/installed.txt"), "utf8"), "installed from provider");
    assert.equal(await readFile(path.join(f.target, "dist/index.mjs"), "utf8"), await readFile(path.join(f.source, "dist/index.mjs"), "utf8"));
    await assert.rejects(access(path.join(f.target, "node_modules/old-install.txt")));
    assert.equal(await readFile(path.join(f.source, "node_modules/old-install.txt"), "utf8"), "must not copy");
  } finally {
    if (oldConfig === undefined) delete process.env.npm_config_userconfig; else process.env.npm_config_userconfig = oldConfig;
    await f.cleanup();
  }
});

test("安装目标已存在时明确拒绝，保留旧版本且不留下半成品目录", async () => {
  const f = await fixture();
  try {
    await mkdir(f.target);
    await writeFile(path.join(f.target, "keep.txt"), "old version");
    await assert.rejects(installRsshub(f.options), /目标目录已存在/);
    assert.equal(await readFile(path.join(f.target, "keep.txt"), "utf8"), "old version");
    assert.deepEqual((await readdir(f.folder)).filter(name => name.startsWith("installed-install-")), []);
  } finally { await f.cleanup(); }
});

test("锁文件安装失败时删除本次半成品、不暴露工具输出或把失败发布成可运行版本", async () => {
  const f = await fixture();
  try {
    await writeFile(f.pnpmCli, `if(process.argv.includes('--version'))console.log('10.34.6');else {
      require('node:fs').mkdirSync('node_modules',{recursive:true});console.error('fixture-private-value');process.exit(1);
    }`);
    await assert.rejects(installRsshub(f.options), error => error instanceof Error && error.message === "RSSHub生产依赖安装失败，请检查固定工具、锁文件和可达性");
    await assert.rejects(access(f.target));
    assert.deepEqual((await readdir(f.folder)).filter(name => name.startsWith("installed-install-")), []);
    assert.equal((await readdir(f.source)).length, 7);
  } finally { await f.cleanup(); }
});

test("安装缓存、构建来源与新版本目录不能重叠，避免改写来源或把缓存当成运行版本", async () => {
  const f = await fixture();
  try {
    for (const storeDirectory of [f.source, f.target, path.join(f.source, "cache"), ...(process.platform === "win32" ? [f.source.toUpperCase()] : [])])
      await assert.rejects(installRsshub({ ...f.options, storeDirectory }), /目录不能重叠/);
    assert.equal((await readdir(f.source)).length, 7);
    await assert.rejects(access(f.target));
  } finally { await f.cleanup(); }
});

test("小磁盘没有4.7GB留白及1GiB安装余量时，安装前拒绝且不留下文件", async () => {
  const f = await fixture();
  try {
    await assert.rejects(installRsshub({ ...f.options, availableBytes: async () => 5_773_741_823n }), /安装空间不足/);
    assert.deepEqual((await readdir(f.folder)).sort(), ["pnpm.cjs", "source"]);
  } finally { await f.cleanup(); }
});

test("缓存路径不能用目录链接绕过独立目录限制", async () => {
  const f = await fixture();
  try {
    await symlink(f.source, f.store, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(installRsshub(f.options), /缓存目录不能是链接/);
    assert.equal((await readdir(f.source)).length, 7);
  } finally { await f.cleanup(); }
});

test("操作员能从独立CLI安装并收到结构化状态，不启动数据库或采集服务", async () => {
  const f = await fixture();
  try {
    const manifest = path.join(f.folder, "approved.json");
    await writeFile(manifest, JSON.stringify(f.manifest));
    await writeFile(f.pnpmCli, `if(process.argv.includes('--version'))console.log('10.34.6');else require('node:fs').mkdirSync('node_modules');`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath, ["modules/studio/scripts/install-rsshub.ts", "--source", f.source,
      "--target", f.target, "--store", f.store, "--pnpm", f.pnpmCli, "--manifest", manifest, "--offline"], { env, windowsHide: true, timeout: 10_000 });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.dependencies, "installed_from_lock");
    assert.equal(output.files, 7);
    assert.equal(output.activated, false);
  } finally { await f.cleanup(); }
});

test("安装期间空闲跌破4.7GB时不保留新版本，并清理本次安装文件", async () => {
  const f = await fixture(); let probes = 0;
  try {
    await writeFile(f.pnpmCli, `if(process.argv.includes('--version'))console.log('10.34.6');else require('node:fs').mkdirSync('node_modules');`);
    await assert.rejects(installRsshub({ ...f.options, availableBytes: async () => probes++ === 0 ? 7_000_000_000n : 4_699_999_999n }), /安装后空闲不足/);
    await assert.rejects(access(f.target));
    assert.deepEqual((await readdir(f.folder)).filter(name => name.startsWith("installed-install-")), []);
  } finally { await f.cleanup(); }
});

test("安装后依赖目录链接仍有效，Windows绝对junction不能因安装目录改名而失效", async () => {
  const f = await fixture();
  try {
    await writeFile(f.pnpmCli, `if(process.argv.includes('--version'))console.log('10.34.6');else {
      const fs=require('node:fs'),path=require('node:path');
      fs.mkdirSync('node_modules/.pnpm/provider',{recursive:true});fs.writeFileSync('node_modules/.pnpm/provider/content.txt','linked dependency');
      fs.symlinkSync(path.resolve('node_modules/.pnpm/provider'),'node_modules/provider',process.platform==='win32'?'junction':'dir');
    }`);
    await installRsshub(f.options);
    assert.equal(await readFile(path.join(f.target, "node_modules/provider/content.txt"), "utf8"), "linked dependency");
  } finally { await f.cleanup(); }
});

test("实际采集入口拒绝仍有安装标记的版本，不把半成品拿去采集", async () => {
  const f = await fixture();
  const previous = { directory: process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY, base: process.env.STUDIO_RSSHUB_BASE_URL, manifest: process.env.STUDIO_RSSHUB_BUILD_MANIFEST };
  try {
    const manifest = path.join(f.folder, "approved.json"); await writeFile(manifest, JSON.stringify(f.manifest));
    process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY = f.source; delete process.env.STUDIO_RSSHUB_BASE_URL; process.env.STUDIO_RSSHUB_BUILD_MANIFEST = manifest;
    await writeFile(f.source + ".installing", "");
    await assert.rejects(readRsshub("http://rsshub.local/qwen/blog?limit=2"), /依赖正在安装或安装尚未完成/);
  } finally {
    for (const [key, value] of [["STUDIO_RSSHUB_NATIVE_DIRECTORY", previous.directory], ["STUDIO_RSSHUB_BASE_URL", previous.base], ["STUDIO_RSSHUB_BUILD_MANIFEST", previous.manifest]])
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    await f.cleanup();
  }
});

test("Windows拒删权限导致失败目录删不掉时，保留安装标记阻止半成品采集", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture();
  const script = path.join(f.folder, "delete-permission.ps1"), locked = path.join(f.target, "node_modules/locked.txt");
  try {
    await writeFile(script, windowsDeletePermissionScript);
    await writeFile(f.pnpmCli, `if(process.argv.includes('--version'))console.log('10.34.6');else {
      const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
      fs.mkdirSync('node_modules');const locked=path.resolve('node_modules/locked.txt');fs.writeFileSync(locked,'unfinished');
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${JSON.stringify(script)},'-LockedFile',locked],{stdio:'ignore',windowsHide:true});
      process.exit(1);
    }`);
    await assert.rejects(installRsshub(f.options));
    await access(locked);
    await access(f.target + ".installing");
  } finally {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-LockedFile", locked, "-Restore"], { windowsHide: true, timeout: 5000 });
    await f.cleanup();
  }
});
