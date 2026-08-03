/**
 * The five transport adapters, richest first.
 *
 * Every adapter presents the same surface: start(config, events), stop(), and
 * a stream of normalized LiveSnapshots. The supervisor knows nothing about how
 * any of them work.
 */

import { RPC_METHOD_NOT_FOUND, buildRpcRequest, getRecentReports, rpcCall } from "@/api/client";
import type { JsonRpcResponse } from "@/api/client";
import { fromClientsFrame, fromLatestStatus, fromV1Report } from "@/api/model";
import type { LiveSnapshot } from "@/api/model";
import type { AdapterEvents, LiveAdapter, TransportConfig } from "./types";
import { wsUrl } from "./types";

const LATEST_STATUS = "common:getNodesLatestStatus";

/* ================================================================== *
 * Tier 1 — JSON-RPC 2.0 over WebSocket
 *
 * The richest channel: recordLike carries `online`, `temp`, `load5`, `load15`
 * and per-task ping stats that the legacy socket simply does not have. It also
 * supports a real application-level heartbeat (`rpc.ping` is a registered
 * method), which the legacy socket does not.
 *
 * Requires server >= 1.0.7.
 * ================================================================== */

const HEARTBEAT_MS = 15_000;

export class Rpc2WebSocketAdapter implements LiveAdapter {
  readonly id = "rpc2-ws" as const;
  readonly label = "RPC·WS";
  readonly kind = "socket" as const;

  private ws: WebSocket | null = null;
  private pollTimer: number | null = null;
  private beatTimer: number | null = null;
  private pending = new Map<number | string, (res: JsonRpcResponse) => void>();
  private stopped = false;

  start(config: TransportConfig, events: AdapterEvents) {
    this.stopped = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl("/api/rpc2"));
    } catch (err) {
      events.onError(err instanceof Error ? err : new Error("rpc2 socket construction failed"));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.request(LATEST_STATUS, events);
      this.pollTimer = window.setInterval(
        () => this.request(LATEST_STATUS, events),
        config.intervalMs,
      );
      // Keeps intermediaries from reaping an idle connection, and gives us a
      // liveness signal independent of the data poll.
      this.beatTimer = window.setInterval(() => this.request("rpc.ping", events, true), HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(event.data as string) as JsonRpcResponse;
      } catch {
        return;
      }
      const resolve = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (resolve) {
        this.pending.delete(msg.id!);
        resolve(msg);
      }
    };

    ws.onerror = () => {
      // Never surfaces a useful reason; onclose does the real work.
      if (!this.stopped) events.onError(new Error("rpc2 socket error"));
    };

    ws.onclose = () => {
      this.clearTimers();
      if (!this.stopped) events.onError(new Error("rpc2 socket closed"));
    };
  }

  private request(method: string, events: AdapterEvents, isHeartbeat = false) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const req = buildRpcRequest(method);
    this.pending.set(req.id, (res) => {
      if (res.error) {
        if (res.error.code === RPC_METHOD_NOT_FOUND) {
          events.onUnsupported(`${method} not available on this server`);
        } else {
          events.onError(new Error(res.error.message));
        }
        return;
      }
      // A heartbeat proves the pipe is alive but carries no fleet data, so it
      // deliberately does NOT reset the staleness watermark.
      if (isHeartbeat) return;
      events.onSnapshot(fromLatestStatus(res.result));
    });

    // Bound the promise map: an unanswered id would otherwise leak forever,
    // since the server sets no write deadline and may simply never reply.
    window.setTimeout(() => this.pending.delete(req.id), 30_000);

    try {
      ws.send(JSON.stringify(req));
    } catch (err) {
      events.onError(err instanceof Error ? err : new Error("rpc2 send failed"));
    }
  }

  private clearTimers() {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.beatTimer !== null) window.clearInterval(this.beatTimer);
    this.pollTimer = null;
    this.beatTimer = null;
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.pending.clear();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
  }
}

/* ================================================================== *
 * Tier 2 — the legacy /api/clients WebSocket
 *
 * Works on every Komari version ever shipped. The protocol is two literal text
 * frames: "get" (everything visible) and "get <uuid>" (one node). Anything else
 * gets {"status":"error"} back and the connection stays open — so there is no
 * heartbeat verb available here; the "get" itself is the keepalive.
 * ================================================================== */

export class ClientsWebSocketAdapter implements LiveAdapter {
  readonly id = "clients-ws" as const;
  readonly label = "WS";
  readonly kind = "socket" as const;

  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private stopped = false;

  start(config: TransportConfig, events: AdapterEvents) {
    this.stopped = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl("/api/clients"));
    } catch (err) {
      events.onError(err instanceof Error ? err : new Error("clients socket construction failed"));
      return;
    }
    this.ws = ws;

    const poll = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send("get");
    };

    ws.onopen = () => {
      poll();
      this.timer = window.setInterval(poll, config.intervalMs);
    };

    ws.onmessage = (event) => {
      let frame: { status?: string; error?: string; data?: unknown };
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (frame.status === "error") {
        events.onError(new Error(frame.error ?? "clients socket rejected the request"));
        return;
      }
      const body = frame.data as { online?: string[]; data?: Record<string, never> } | undefined;
      if (!body) return;
      events.onSnapshot(fromClientsFrame(body));
    };

    ws.onerror = () => {
      if (!this.stopped) events.onError(new Error("clients socket error"));
    };

    ws.onclose = () => {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      if (!this.stopped) events.onError(new Error("clients socket closed"));
    };
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
  }
}

/* ================================================================== *
 * Tier 3 — Server-Sent Events (dormant by default)
 *
 * Komari ships no SSE endpoint, so this tier is skipped unless an operator
 * sets `sse_endpoint` to a bridge that re-emits Komari's data as
 * text/event-stream. The adapter is real and complete; it simply has nothing
 * to connect to on a stock install.
 *
 * Accepted payloads, in order of preference:
 *   1. a uuid-keyed map of recordLike        (flat, richest)
 *   2. {online:[...], data:{uuid: Report}}   (a raw /api/clients frame)
 *   3. {data:{...}} wrapping either of those
 * ================================================================== */

export class SseAdapter implements LiveAdapter {
  readonly id = "sse" as const;
  readonly label = "SSE";
  readonly kind = "socket" as const;

  private source: EventSource | null = null;
  private stopped = false;

  start(config: TransportConfig, events: AdapterEvents) {
    this.stopped = false;

    if (!config.sseEndpoint) {
      events.onUnsupported("no sse_endpoint configured (Komari has no built-in SSE)");
      return;
    }
    if (typeof EventSource === "undefined") {
      events.onUnsupported("EventSource unavailable in this browser");
      return;
    }

    let source: EventSource;
    try {
      source = new EventSource(config.sseEndpoint, { withCredentials: true });
    } catch (err) {
      events.onUnsupported(err instanceof Error ? err.message : "invalid sse_endpoint");
      return;
    }
    this.source = source;

    source.onmessage = (event) => {
      const snapshot = parseSsePayload(event.data);
      if (snapshot) events.onSnapshot(snapshot);
    };

    source.onerror = () => {
      // EventSource reconnects on its own, but a permanently CLOSED source is
      // fatal and must be reported so the supervisor can step down.
      if (this.stopped) return;
      events.onError(
        new Error(
          source.readyState === EventSource.CLOSED
            ? "SSE stream closed"
            : "SSE stream interrupted",
        ),
      );
    };
  }

  stop() {
    this.stopped = true;
    if (this.source) {
      this.source.onmessage = this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }
}

function parseSsePayload(raw: string): LiveSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const body = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<
    string,
    unknown
  >;

  // A legacy /api/clients frame relayed verbatim.
  if (Array.isArray(body.online) || (body.data && typeof body.data === "object")) {
    return fromClientsFrame(body as { online?: string[]; data?: Record<string, never> });
  }
  return fromLatestStatus(body);
}

/* ================================================================== *
 * Tier 4 — JSON-RPC over plain HTTP POST
 *
 * Same method as tier 1, so the payload is identically rich. Survives proxies
 * and captive networks that break WebSocket upgrades entirely.
 * ================================================================== */

export class Rpc2HttpAdapter implements LiveAdapter {
  readonly id = "rpc2-http" as const;
  readonly label = "RPC·HTTP";
  readonly kind = "poll" as const;

  private timer: number | null = null;
  private inFlight = false;
  private stopped = false;

  start(config: TransportConfig, events: AdapterEvents) {
    this.stopped = false;

    const tick = async () => {
      // Skip rather than queue: on a slow link, overlapping polls would pile up
      // and make the connection look worse than it is.
      if (this.inFlight || this.stopped) return;
      this.inFlight = true;
      try {
        const result = await rpcCall<unknown>(LATEST_STATUS);
        if (!this.stopped) events.onSnapshot(fromLatestStatus(result));
      } catch (err) {
        const code = (err as { rpcCode?: number }).rpcCode;
        if (code === RPC_METHOD_NOT_FOUND) {
          events.onUnsupported(`${LATEST_STATUS} not available on this server`);
        } else if (!this.stopped) {
          events.onError(err instanceof Error ? err : new Error("rpc2 http poll failed"));
        }
      } finally {
        this.inFlight = false;
      }
    };

    void tick();
    this.timer = window.setInterval(() => void tick(), config.intervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}

/* ================================================================== *
 * Tier 5 — per-node /api/recent/:uuid fan-out
 *
 * Last resort, for servers too old to have rpc2 at all. This costs one request
 * per node per tick, so it is hard-capped and runs on a slower cadence. The
 * endpoint returns the last ~60s from an in-memory buffer in the NESTED shape.
 *
 * Caveat worth knowing: there is no fleet-wide online list on this path, so
 * liveness is inferred from report freshness.
 * ================================================================== */

const RECENT_MAX_NODES = 40;
const RECENT_MIN_INTERVAL = 5_000;
/** A report older than this is treated as an offline node. */
const RECENT_STALE_MS = 15_000;

export class RecentHttpAdapter implements LiveAdapter {
  readonly id = "recent-http" as const;
  readonly label = "POLL";
  readonly kind = "poll" as const;

  private timer: number | null = null;
  private inFlight = false;
  private stopped = false;

  start(config: TransportConfig, events: AdapterEvents) {
    this.stopped = false;
    const interval = Math.max(config.intervalMs, RECENT_MIN_INTERVAL);

    const tick = async () => {
      if (this.inFlight || this.stopped) return;
      const ids = config.getNodeIds().slice(0, RECENT_MAX_NODES);
      if (ids.length === 0) return;

      this.inFlight = true;
      try {
        const now = Date.now();
        const results = await Promise.allSettled(ids.map((id) => getRecentReports(id)));
        if (this.stopped) return;

        const snapshot: LiveSnapshot = {};
        let anyOk = false;

        results.forEach((res, i) => {
          if (res.status !== "fulfilled") return;
          anyOk = true;
          const uuid = ids[i]!;
          const latest = res.value.at(-1);
          if (!latest) return;
          const at = Date.parse(latest.updated_at);
          const fresh = Number.isFinite(at) ? now - at < RECENT_STALE_MS : false;
          snapshot[uuid] = fromV1Report(uuid, latest, fresh, now);
        });

        if (anyOk) events.onSnapshot(snapshot);
        else events.onError(new Error("every recent-records request failed"));
      } finally {
        this.inFlight = false;
      }
    };

    void tick();
    this.timer = window.setInterval(() => void tick(), interval);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}

/** Ladder order, richest first. */
export function createAdapters(): LiveAdapter[] {
  return [
    new Rpc2WebSocketAdapter(),
    new ClientsWebSocketAdapter(),
    new SseAdapter(),
    new Rpc2HttpAdapter(),
    new RecentHttpAdapter(),
  ];
}
