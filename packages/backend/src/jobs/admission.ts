import type { QueueAdmission } from "../modules.ts";

/** Share installed resource gates until the last queue's in-flight work has drained. */
export function sharedQueueAdmission(factories: QueueAdmission[]): QueueAdmission | undefined {
  if (!factories.length) return undefined;
  let gates: ReturnType<QueueAdmission>[] | undefined, consumers = 0;
  function stop(owned: ReturnType<QueueAdmission>[]) {
    const failures = [];
    for (const gate of owned) try { gate.stop(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "资源准入未能全部停止");
  }
  return () => {
    if (!gates) {
      const acquired: ReturnType<QueueAdmission>[] = [];
      try { for (const factory of factories) acquired.push(factory()); }
      catch (error) { try { stop(acquired); } catch {} throw error; }
      gates = acquired;
    }
    const owned = gates;
    consumers++;
    let stopped = false;
    return { canStart: () => !stopped && owned.every(gate => gate.canStart()), stop() {
      if (stopped) return;
      stopped = true;
      if (--consumers === 0) { gates = undefined; stop(owned); }
    } };
  };
}
