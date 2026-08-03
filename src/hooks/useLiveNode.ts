import { useEffect, useRef, useState } from "react";
import { liveBus } from "@/store/live";
import type { LiveRecord, LiveSnapshot } from "@/api/model";

/**
 * Subscribes to one node's telemetry OUTSIDE React's render cycle.
 *
 * The callback fires on every tick (~2s). It must only write to the DOM — via
 * refs or GSAP — and must never call setState, or we are back to re-rendering
 * the whole grid several times a minute.
 */
export function useLiveNode(uuid: string, onTick: (record: LiveRecord | undefined) => void) {
  const cb = useRef(onTick);
  cb.current = onTick;

  useEffect(() => {
    // Paint immediately from whatever is already in the bus, so a card mounted
    // mid-session is not blank until the next tick.
    cb.current(liveBus.get(uuid));
    return liveBus.subscribeNode(uuid, (record) => cb.current(record));
  }, [uuid]);
}

/** Same contract, but for consumers that need the whole fleet each tick. */
export function useLiveFleet(onTick: (snapshot: LiveSnapshot) => void) {
  const cb = useRef(onTick);
  cb.current = onTick;

  useEffect(() => {
    cb.current(liveBus.current);
    return liveBus.subscribe((snapshot) => cb.current(snapshot));
  }, []);
}

/**
 * Re-renders only when the fleet's *shape* changes — a node appears,
 * disappears, or flips online/offline. Metric churn does not trigger this,
 * which is what keeps a 100-node grid off the reconciler every 2 seconds.
 */
export function useFleetStructure(): string {
  const [key, setKey] = useState(liveBus.structureKey);
  useEffect(() => liveBus.subscribeStructure(setKey), []);
  return key;
}
