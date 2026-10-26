// Local operator entry point. It never loads the original FastlaneNews environment.
import path from "node:path";
import { LocalError, readLocalConfiguration } from "./studio-config.ts";

const root = path.resolve(import.meta.dirname, "..");
const file = process.env.STUDIO_LOCAL_ENV || path.join(root, ".env");
try {
  const command = process.argv[2] ?? "check";
  if (!["check", "start", "stop", "status", "resources", "test"].includes(command)) throw new LocalError("LOCAL_COMMAND_UNKNOWN", "可用命令：check、start、status、resources、stop、test。");
  if (command === "status" || command === "stop" || command === "resources") {
    const { controlLocal } = await import("./studio-runtime.ts");
    const result = await controlLocal(command);
    console.log(JSON.stringify(result));
    if (command === "resources" && !result.ok) process.exitCode = 1;
  } else {
  const { env, database } = await readLocalConfiguration(file);
  if (command === "test") {
    const { runLocalTests } = await import("./studio-test.ts");
    await runLocalTests(database, process.argv.slice(3));
  } else if (command === "start") {
    const { startLocal, startLocalWindows } = await import("./studio-runtime.ts");
    if (process.platform === "win32") await startLocalWindows(path.resolve(file));
    else await startLocal(env);
  } else console.log(JSON.stringify({ ok: true, database: "ready", app: "not_checked" }));
  }
} catch (error) {
  const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
  const messages: Record<string, string> = {
    LOCAL_ALREADY_RUNNING: "已有本项目运行记录。请先使用 status 检查，使用 stop 停止；工具不会结束其他进程。",
    LOCAL_START_FAILED: "本机服务未能启动，请查看本项目运行目录中的 api.log 和 web.log。",
    LOCAL_PATH_REFUSED: "运行数据和控制文件必须位于本项目 .local 目录内。",
    LOCAL_PORT_INVALID: "本机端口必须为 1024 至 65535 的整数。",
    LOCAL_PORT_CONFLICT: "API 和网页不能使用同一个端口。",
    LOCAL_SERVER_URL_INVALID: "服务器模式需要不带路径、查询或账号信息的 HTTPS 站点地址。",
    LOCAL_AUTH_REQUIRED: "请为本项目设置至少 12 位的登录密码与签名密钥。",
    LOCAL_STATE_INVALID: "本项目运行记录无效，未发送停止指令。",
    LOCAL_CONTROL_REFUSED: "控制接口拒绝了请求，未结束任何其他进程。",
    LOCAL_CONTROL_UNAVAILABLE: "本项目控制接口无法连接。请核对运行记录和对应进程，不要按旧 PID 结束其他服务。",
    LOCAL_RESOURCE_STATE_UNCONFIRMED: "本项目资源组正在准备或退出尚未确认，请稍后重试；持续出现时先核对任务和控制记录，不要直接删除记录或按旧PID结束进程。",
    LOCAL_TEST_DATABASE_INVALID: "测试库名必须为 63 字符以内的字母数字下划线名称，以 _test 或 _ci 结尾。",
    LOCAL_TEST_FILES_INVALID: "只允许运行本项目 tests 或 modules 内 tests 目录下的 TypeScript 测试文件。",
  };
  const runtimeCode = error instanceof Error && messages[error.message] ? error.message : null;
  console.log(JSON.stringify({ ok: false, code: error instanceof LocalError ? error.code : runtimeCode ?? (missing ? "LOCAL_ENV_MISSING" : "LOCAL_CONFIG_INVALID"),
    message: error instanceof LocalError ? error.message : runtimeCode ? messages[runtimeCode] : missing ? "缺少本项目的本机配置文件。请按本机运行说明准备配置。" : "本机配置或运行状态无法读取，请检查配置与运行记录。" }));
  process.exitCode = 1;
}
