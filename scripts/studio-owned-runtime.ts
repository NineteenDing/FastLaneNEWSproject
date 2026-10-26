// Internal bootstrap, launched suspended in the Windows Job. No credentials in argv/environment.
import { readLocalConfiguration } from "./studio-config.ts";
const [file, runDirectory, groupId] = process.argv.slice(2);
if (!file || !runDirectory || !/^[a-f0-9]{64}$/.test(groupId ?? "")) throw new Error("LOCAL_START_FAILED");
process.env.STUDIO_LOCAL_RUN_DIR = runDirectory;
const { startLocal } = await import("./studio-runtime.ts");
try { await startLocal((await readLocalConfiguration(file)).env, { groupId }); }
catch { process.exitCode = 1; }
