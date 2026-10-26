import { AsyncLocalStorage } from "node:async_hooks";

const admission = new AsyncLocalStorage<() => boolean>();
export class ImageProcessingUnavailable extends Error {}

/** HTTP-scoped admission; worker media preparation keeps its separately owned queue monitors. */
export function withImageProcessingAdmission<T>(allowed: () => boolean, run: () => T): T {
  return admission.run(allowed, run);
}

export function assertImageProcessingAllowed(): void {
  const allowed = admission.getStore();
  if (allowed && !allowed()) throw new ImageProcessingUnavailable("图片处理资源暂不可用，请稍后重试");
}
