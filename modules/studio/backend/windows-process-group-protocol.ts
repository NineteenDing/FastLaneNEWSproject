/** Wire contract also emitted by windows-process-group.cs; all numbers are JSON integers. */
export type WindowsProcessGroupStatus = {
  rootProcessId: number; activeProcesses: number; cpuPercent: number; memoryLimitBytes: number;
  /** Internal ownership only; operator status removes process identifiers. */
  processIds?: number[];
};
export type WindowsProcessGroupResult = { exitCode: number; peakMemoryBytes: number };
export type WindowsProcessGroupMessage =
  | ({ type: "status" } & WindowsProcessGroupStatus)
  | ({ type: "result" } & WindowsProcessGroupResult)
  | { type: "error" };

export function readWindowsProcessGroupMessage(value: unknown): WindowsProcessGroupMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const integer = (key: string, minimum: number, maximum: number) => typeof message[key] === "number"
    && Number.isSafeInteger(message[key]) && message[key] >= minimum && message[key] <= maximum;
  if (message.type === "error") return { type: "error" };
  const processIds = message.processIds;
  if (processIds !== undefined && (!Array.isArray(processIds) || processIds.length > 8192 || processIds.length !== message.activeProcesses
    || new Set(processIds).size !== processIds.length || !processIds.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 0xffffffff))) return null;
  if (message.type === "status" && integer("rootProcessId", 1, 0xffffffff) && integer("activeProcesses", 0, 0xffffffff)
    && integer("cpuPercent", 1, 75) && integer("memoryLimitBytes", 64 * 1024 ** 2, 6 * 1024 ** 3))
    return { type: "status", rootProcessId: message.rootProcessId as number, activeProcesses: message.activeProcesses as number,
      cpuPercent: message.cpuPercent as number, memoryLimitBytes: message.memoryLimitBytes as number,
      ...(processIds !== undefined ? { processIds: [...processIds as number[]] } : {}) };
  if (message.type === "result" && integer("exitCode", 0, 0xffffffff) && integer("peakMemoryBytes", 0, Number.MAX_SAFE_INTEGER))
    return { type: "result", exitCode: message.exitCode as number, peakMemoryBytes: message.peakMemoryBytes as number };
  return null;
}
