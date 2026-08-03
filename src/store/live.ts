/**
 * The live-data bus.
 *
 * Deliberately NOT React state. At a 2s cadence with 100+ cards, routing every
 * tick through useState re-renders the whole grid ~30 times a minute and makes
 * GSAP fight the reconciler for the same DOM nodes.
 *
 * Instead: snapshots land here, components subscribe imperatively, and each
 * card writes its own numbers via gsap.quickTo(). React re-renders only when
 * something *structural* changes — a node appears, disappears, or flips
 * online/offline — which is what `structureKey` detects.
 */

import type { LiveRecord, LiveSnapshot } from "@/api/model";

type Listener = (snapshot: LiveSnapshot) => void;
type NodeListener = (record: LiveRecord | undefined) => void;

class LiveBus {
  private snapshot: LiveSnapshot = {};
  private listeners = new Set<Listener>();
  private nodeListeners = new Map<string, Set<NodeListener>>();

  /** Changes only when the set of nodes or their online-ness changes. */
  private structure = "";
  private structureListeners = new Set<(key: string) => void>();

  get current(): LiveSnapshot {
    return this.snapshot;
  }

  get(uuid: string): LiveRecord | undefined {
    return this.snapshot[uuid];
  }

  get structureKey(): string {
    return this.structure;
  }

  publish(snapshot: LiveSnapshot) {
    this.snapshot = snapshot;

    const nextStructure = computeStructureKey(snapshot);
    const structureChanged = nextStructure !== this.structure;
    this.structure = nextStructure;

    for (const fn of this.listeners) fn(snapshot);

    for (const [uuid, subs] of this.nodeListeners) {
      const record = snapshot[uuid];
      for (const fn of subs) fn(record);
    }

    if (structureChanged) {
      for (const fn of this.structureListeners) fn(nextStructure);
    }
  }

  /** Every tick, for consumers that genuinely need the whole fleet. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every tick, scoped to one node. This is what NodeCard uses. */
  subscribeNode(uuid: string, fn: NodeListener): () => void {
    let subs = this.nodeListeners.get(uuid);
    if (!subs) {
      subs = new Set();
      this.nodeListeners.set(uuid, subs);
    }
    subs.add(fn);
    return () => {
      const set = this.nodeListeners.get(uuid);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this.nodeListeners.delete(uuid);
    };
  }

  /** Only when the fleet's shape changes — safe to drive React with. */
  subscribeStructure(fn: (key: string) => void): () => void {
    this.structureListeners.add(fn);
    return () => this.structureListeners.delete(fn);
  }

  reset() {
    this.snapshot = {};
    this.structure = "";
  }
}

function computeStructureKey(snapshot: LiveSnapshot): string {
  const parts: string[] = [];
  // Sorted so key equality is not at the mercy of object key ordering.
  for (const uuid of Object.keys(snapshot).sort()) {
    parts.push(snapshot[uuid]!.online ? `${uuid}+` : `${uuid}-`);
  }
  return parts.join("|");
}

export const liveBus = new LiveBus();
