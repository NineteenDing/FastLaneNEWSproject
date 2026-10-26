import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { rsshubState } from "./rsshub-client.ts";
import type { RuntimeComponents } from "../contracts.ts";

const root = path.resolve(import.meta.dirname, "../../..");
/** Fast local file checks only. Model weights are not loaded; no browser, subprocess or network starts. */
export async function runtimeComponents(): Promise<RuntimeComponents> {
  const selected = (name: string, fallback: string) => path.resolve(root, process.env[name] || fallback);
  async function file(name: string, bytes?: number) {
    try { const info = await lstat(name); return info.isFile() && !info.isSymbolicLink() && (bytes === undefined || info.size === bytes); }
    catch { return false; }
  }
  const crawlerPython = selected("STUDIO_MEDIACRAWLER_PYTHON", "runtime/mediacrawler-env/Scripts/python.exe");
  const crawlerSource = selected("STUDIO_MEDIACRAWLER_SOURCE", "runtime/mediacrawler-source");
  const asrPython = selected("STUDIO_ASR_PYTHON", "runtime/asr-env/Scripts/python.exe");
  const asrModel = selected("STUDIO_ASR_MODEL_DIRECTORY", "runtime/asr-model-large-v3-turbo-int8");
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, "../vendor/faster-whisper/runtime.json"), "utf8")) as { model: { bytes: number } };
  const [crawler, speech, model, browser] = await Promise.all([
    Promise.all([file(crawlerPython), file(path.join(crawlerSource, "media_platform/bilibili/client.py")), file(path.join(crawlerSource, "uv.lock"))]).then(rows => rows.every(Boolean)),
    file(asrPython), file(path.join(asrModel, "model.bin"), manifest.model.bytes), file(chromium.executablePath()),
  ]);
  const bridge = rsshubState();
  return { checkedAt: new Date().toISOString(), check: "local_files", rows: [
    { id: "mediacrawler", name: "七平台采集组件", state: crawler ? "files_present" : "missing", detail: crawler ? "Python、客户端与依赖锁文件在位；实际运行仍会核对固定版本。" : "采集Python或固定源码/依赖锁缺失，请准备本项目独立运行环境。" },
    { id: "chromium", name: "浏览器采集", state: browser ? "files_present" : "missing", detail: browser ? "Playwright浏览器文件在位，尚未在此次检查启动。" : "本项目Playwright浏览器尚未安装，页面型采集会受影响。" },
    { id: "asr", name: "本地转写", state: speech && model ? "files_present" : "missing", detail: speech && model ? "转写Python与模型文件大小符合配置；正式处理前仍校验模型摘要。" : !speech ? "转写Python缺失，请准备本项目CPU转写环境。" : "模型缺失或大小不符，请准备固定版本模型；不会改用收费转写。" },
    { id: "rsshub", name: "RSSHub新闻桥接", state: bridge === "configured" ? "configured" : bridge === "invalid" ? "invalid" : "not_configured", detail: bridge === "configured" ? "运行配置已填写，本次未访问服务或校验其构建。" : bridge === "invalid" ? "RSSHub运行配置无效，请核对独立目录或本机服务地址。" : "尚未配置RSSHub；普通RSS与博主采集不依赖它。" },
  ] };
}
