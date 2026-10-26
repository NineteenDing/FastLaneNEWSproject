import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createImageStorage } from "./image-storage.ts";

/** Worker-only maintenance. Status readers remain read-only and referenced assets keep their own retention. */
export async function pruneStorageUnderPressure() {
  const disk = createDiskResourceMonitor();
  await disk.sample();
  const before = disk.status();
  if (before.unreservedBytes === null) throw new Error("磁盘状态无法确认，未执行压力清理，请稍后重试");
  if (before.state === "normal") return { prunedCache: 0, disk: before };
  const prunedCache = await createImageStorage().prune(new Date(Date.now() - 30 * 86400_000));
  await disk.sample();
  const after = disk.status();
  if (after.unreservedBytes === null) throw new Error("清理后磁盘状态无法确认，请稍后重新检查");
  return { prunedCache, disk: after };
}
