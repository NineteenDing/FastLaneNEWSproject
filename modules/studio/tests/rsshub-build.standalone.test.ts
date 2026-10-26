import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { verifyRsshubBuild } from "../backend/rsshub-build.ts";

const files: Record<string, string> = {
  "package.json": '{"name":"rsshub-fixture","type":"module"}\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "LICENSE": "Fixture license\n", "README.md": "# RSSHub fixture\n",
  "patches/rss-parser.patch": "fixture patch\n", "public/health.txt": "fixture static\n",
  "dist/index.mjs": "export {default} from './route.mjs';\n",
  "dist/route.mjs": "export default {fetch:()=>new Response('verified fixture')};\n",
};

async function buildFixture() {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/rsshub-build-test-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), content);
  }
  return folder;
}
async function removeBuildFixture(folder: string) {
  assert.ok(path.resolve(folder).startsWith(path.resolve(".local") + path.sep));
  await rm(folder, { recursive: true, force: true });
}

test("运行前检查整个RSSHub构建，入口未变但其他路由文件被修改也拒绝", async () => {
  await mkdir(".local", { recursive: true });
  const folder = await buildFixture();
  try {
    const manifest = { schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225, sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" };
    assert.equal((await verifyRsshubBuild(folder, manifest)).files, 8);
    await writeFile(path.join(folder, "dist/route.mjs"), "throw new Error('changed route');");
    await assert.rejects(verifyRsshubBuild(folder, manifest), /构建文件与固定清单不一致/);
  } finally {
    await removeBuildFixture(folder);
  }
});

test("运行目录混入包管理器配置或环境文件时拒绝，不能继承下载钩子与凭据", async () => {
  const folder = await buildFixture();
  try {
    const manifest = { schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225, sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" };
    await writeFile(path.join(folder, ".npmrc"), "ignore-scripts=false\n");
    await assert.rejects(verifyRsshubBuild(folder, manifest), /含未批准文件/);
  } finally {
    await removeBuildFixture(folder);
  }
});

test("构建相同但Node版本不匹配时拒绝，不能直接照搬开发机依赖", async () => {
  const folder = await buildFixture();
  try {
    const manifest = { schema: 1, nodeVersion: "99.0.0", pnpmVersion: "10.34.6", files: 8, bytes: 225, sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" };
    await assert.rejects(verifyRsshubBuild(folder, manifest), /Node版本不匹配/);
  } finally {
    await removeBuildFixture(folder);
  }
});

test("异常膨胀的构建文件在读入内存前拒绝，校验不能耗尽小服务器资源", async () => {
  const folder = await buildFixture();
  try {
    const manifest = { schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225, sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" };
    await truncate(path.join(folder, "dist/route.mjs"), 64 * 1024 * 1024 + 1);
    await assert.rejects(verifyRsshubBuild(folder, manifest), /超出构建校验预算/);
  } finally {
    await removeBuildFixture(folder);
  }
});

test("未知格式的固定清单不能被当作已验证版本", async () => {
  const folder = await buildFixture();
  try {
    await assert.rejects(verifyRsshubBuild(folder, { schema: 2, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225,
      sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" }), /固定清单无效/);
  } finally {
    await removeBuildFixture(folder);
  }
});

test("操作员可独立检查构建而不启动应用，缺文件时返回明确失败", async () => {
  const folder = await buildFixture();
  const manifestFile = folder + "-manifest.json";
  try {
    await writeFile(manifestFile, JSON.stringify({ schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225,
      sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" }));
    const exec = promisify(execFile);
    const command = () => exec(process.execPath, ["modules/studio/scripts/check-rsshub.ts", folder, manifestFile], { windowsHide: true, timeout: 5000 });
    const result = JSON.parse((await command()).stdout);
    assert.equal(result.build, "verified");
    assert.equal(result.files, 8);
    assert.equal(result.dependencies, "not_checked");
    await rm(path.join(folder, "dist/route.mjs"));
    await assert.rejects(command(), error => {
      const output = JSON.parse((error as { stdout: string }).stdout);
      return output.ok === false && /构建/.test(output.message) && !output.message.includes(folder);
    });
  } finally {
    await removeBuildFixture(folder);
    await rm(manifestFile, { force: true });
  }
});

test("构建检查在扫描前拒绝运行目录之外的路径", async () => {
  await assert.rejects(verifyRsshubBuild(path.resolve("."), { schema: 1, nodeVersion: "24.21.0", pnpmVersion: "10.34.6", files: 8, bytes: 225,
    sha256: "75ad9bab198a425d5e03971be79de36cfe3fb446cff3584a99eb7b1e36d0d8c5" }), /本项目独立运行目录/);
});
