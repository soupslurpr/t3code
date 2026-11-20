import type { ComputerAutomationAction } from "@t3tools/contracts";

type KeyAction = Extract<ComputerAutomationAction, { type: "key_down" | "key_up" }>;

/** Each queue targets one control lease. Drain it before handing that lease to another viewer. */
export function createViewerKeys(send: (action: KeyAction) => Promise<void>) {
  const physical = new Map<string, string>();
  const sent = new Set<string>();
  let generation = 0;
  let closed = false;
  let tail = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const lift = (key: string) =>
    enqueue(async () => {
      if (!sent.has(key)) return;
      await send({ type: "key_up", key });
      sent.delete(key);
    });
  const blur = () => {
    generation++;
    physical.clear();
    return enqueue(async () => {
      for (const key of [...sent].reverse()) {
        await send({ type: "key_up", key });
        sent.delete(key);
      }
    });
  };
  return {
    down(physicalKey: string, key: string) {
      if (closed || physical.has(physicalKey)) return tail;
      const shared = [...physical.values()].includes(key);
      physical.set(physicalKey, key);
      const epoch = generation;
      if (shared) return tail;
      return enqueue(async () => {
        if (closed || generation !== epoch || sent.has(key)) return;
        await send({ type: "key_down", key });
        sent.add(key);
      });
    },
    up(physicalKey: string) {
      const key = physical.get(physicalKey);
      physical.delete(physicalKey);
      return key === undefined || [...physical.values()].includes(key) ? tail : lift(key);
    },
    blur,
    close() {
      closed = true;
      return blur();
    },
  };
}
