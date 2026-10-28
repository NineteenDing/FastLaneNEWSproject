/** R/(C+R)<=20% is exactly R<=floor(C/4). Counts are distinct admitted events, never duplicate reports. */
export function referenceCapacity(coreEvents: number) {
  if (!Number.isSafeInteger(coreEvents) || coreEvents < 0) throw new Error("核心事件计数无效");
  return Math.floor(coreEvents / 4);
}
