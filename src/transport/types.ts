import type { LiveSnapshot } from "@/api/model";

/**
 * Identifiers for each rung of the fallback ladder, richest first.
 *
 * A note on why this ladder exists at all: Komari has NO Server-Sent Events
 * endpoint (verified against web/router/router.go — no text/event-stream, no
 * c.Stream, no SSE route anywhere), and neither of its WebSockets actually
 * pushes. `/api/clients` blocks on ReadMessage() and answers exactly one frame
 * per "get" it receives; `/api/rpc2` is strict request/response too. So every
 * tier here is really "poll, over some pipe" — the pipes just differ in
 * richness, framing cost, and how likely a hostile proxy is to break them.
 */
export type TierId = "rpc2-ws" | "clients-ws" | "sse" | "rpc2-http" | "recent-http";

/** Coarse connection state surfaced to the UI. */
export type LinkState = "connecting" | "live" | "degraded" | "stale" | "offline";

export interface TransportConfig {
  /** Poll cadence in ms. Below ~2000 buys nothing: the server needs ~11s to mark an agent offline. */
  intervalMs: number;
  /**
   * Operator-supplied EventSource URL. Empty (the default) removes the SSE tier
   * from the ladder entirely, because stock Komari has nothing to connect to.
   */
  sseEndpoint: string;
  /** Pin a single tier for debugging; "auto" runs the full ladder. */
  preference: "auto" | TierId;
  /** UUIDs the recent-http tier should fan out over. Capped by the adapter. */
  getNodeIds: () => string[];
}

export interface AdapterEvents {
  /** A complete fleet snapshot arrived. Resets the staleness watermark. */
  onSnapshot(snapshot: LiveSnapshot): void;
  /** Recoverable failure — the supervisor counts these toward demotion. */
  onError(error: Error): void;
  /**
   * This transport cannot work on this server at all (e.g. rpc2 predates the
   * server version). The supervisor drops the tier permanently instead of
   * retrying it, so we do not waste a promotion cycle on it later.
   */
  onUnsupported(reason: string): void;
}

export interface LiveAdapter {
  readonly id: TierId;
  /** Short label for the connection badge. */
  readonly label: string;
  /** Whether the pipe is long-lived. Purely informational for the UI. */
  readonly kind: "socket" | "poll";
  start(config: TransportConfig, events: AdapterEvents): void;
  stop(): void;
}

/** Derives ws:// or wss:// from the current page, never a hardcoded host.
 *
 * This is mandatory, not stylistic: since GHSA-q355-h244-969h the server
 * enforces a CheckOrigin on every upgrade, and the browser always sends Origin.
 * A hardcoded host breaks reverse-proxy and custom-domain deployments.
 */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
