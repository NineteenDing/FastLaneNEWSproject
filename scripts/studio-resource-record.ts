import { renameSync } from "node:fs";

/** Windows may briefly deny atomic replacement while another process reads it.
 * Keep the old record intact; retry only sharing-like errors, at most 150ms.
 * Persistent failure still reaches the existing fail-closed group shutdown. */
export function replaceResourceRecordSync(temporary: string, target: string) {
  const delays = [10, 20, 40, 80], pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(code ?? "") || attempt >= delays.length) throw error;
      Atomics.wait(pause, 0, 0, delays[attempt]);
    }
  }
}
