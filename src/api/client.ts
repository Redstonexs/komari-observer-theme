/**
 * Thin fetch wrappers over Komari's public REST surface.
 *
 * Route table verified against web/router/router.go. Note that DeepWiki
 * documents `/api/records`, `/api/ping-records` and `/api/ping-tasks` — none of
 * those paths have ever existed. The real ones are below.
 */

import type {
  Envelope,
  LoadRecordsResponse,
  LoadType,
  Me,
  NodeInfo,
  PingRecordsResponse,
  PublicPingTask,
  PublicSettings,
  V1Report,
  VersionInfo,
} from "./types";

/** Thrown for any non-2xx response so callers can branch on status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Private-site gate, or a session that expired. */
  get isAuthRequired() {
    return this.status === 401;
  }

  /** Origin rejected by the CORS middleware (web/security/cors.go). */
  get isForbidden() {
    return this.status === 403;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      // Session auth is a `session_token` cookie; without credentials the
      // server treats us as a guest and hides `hidden` nodes.
      credentials: "same-origin",
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    throw new ApiError(0, `Network error requesting ${path}`, path);
  }

  if (!res.ok) {
    // Error bodies use {status:"error", message}. A 403 from the CORS
    // middleware has no body at all, so guard the parse.
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* empty or non-JSON body */
    }
    throw new ApiError(res.status, message, path);
  }

  return (await res.json()) as T;
}

/** Unwraps the standard {status, message, data} envelope. */
async function unwrap<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await request<Envelope<T>>(path, init);
  if (body.status === "error") {
    throw new ApiError(200, body.message ?? "Request failed", path);
  }
  // `data` is omitted when the RPC result is nil.
  return body.data as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ------------------------------------------------------------------ *
 * Public endpoints
 * ------------------------------------------------------------------ */

/** Site config + this theme's settings. Stays reachable even on a private site. */
export function getPublicSettings(): Promise<PublicSettings> {
  return unwrap<PublicSettings>("/api/public");
}

/**
 * Current user. The ONE public endpoint returning a bare object with no
 * envelope (bound with WithRaw()). Returns 200 for guests, never 401 — so
 * `logged_in` is the only reliable auth signal.
 */
export function getMe(): Promise<Me> {
  return request<Me>("/api/me");
}

export function getVersion(): Promise<VersionInfo> {
  return unwrap<VersionInfo>("/api/version");
}

/** Static node metadata. 401s for guests when the site is private. */
export function getNodes(): Promise<NodeInfo[]> {
  return unwrap<NodeInfo[]>("/api/nodes");
}

/**
 * Last ~60 seconds of reports for one node, in the NESTED v1.Report shape.
 * This is an in-memory ring buffer, not a DB query — it is wiped on server
 * restart and is unsuitable as a chart source.
 */
export function getRecentReports(uuid: string): Promise<V1Report[]> {
  return unwrap<V1Report[]>(`/api/recent/${encodeURIComponent(uuid)}`);
}

/**
 * Historical load records in the FLAT models.Record shape.
 *
 * Server-side downsampled, so do not decimate again — and note that the
 * cadence is NOT fixed: a one-day window comes back at a few minutes per
 * record while a one-week window comes back roughly hourly. Anything reasoning
 * about the spacing has to measure it from the response.
 *
 * Omit `loadType` to receive every field plus `gpu_devices`. Passing
 * `load_type=gpu` returns HTTP 400 — the allowlist omits it (server bug).
 */
export function getLoadRecords(
  uuid: string,
  hours = 4,
  loadType?: LoadType,
  init?: RequestInit,
): Promise<LoadRecordsResponse> {
  return unwrap<LoadRecordsResponse>(
    `/api/records/load${qs({ uuid, hours, load_type: loadType })}`,
    init,
  );
}

/**
 * Ping history. At least one of uuid / taskId is required.
 *
 * `records[].value` is milliseconds; a NEGATIVE value means packet loss and
 * must be rendered as a gap, not as a latency.
 *
 * Requesting a hidden uuid as a guest returns 200 with an empty result rather
 * than 403 — empty is not an error.
 */
export function getPingRecords(opts: {
  uuid?: string;
  taskId?: number;
  hours?: number;
}): Promise<PingRecordsResponse> {
  return unwrap<PingRecordsResponse>(
    `/api/records/ping${qs({
      uuid: opts.uuid,
      task_id: opts.taskId,
      hours: opts.hours ?? 4,
    })}`,
  );
}

/** Public ping task list. The probe `target` is never exposed. */
export function getPingTasks(): Promise<PublicPingTask[]> {
  return unwrap<PublicPingTask[]>("/api/task/ping");
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 (/api/rpc2) — richer, but only on server >= 1.0.7
 * ------------------------------------------------------------------ */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC "method not found" — our capability-probe signal. */
export const RPC_METHOD_NOT_FOUND = -32601;

let rpcId = 0;
export const nextRpcId = () => ++rpcId;

export function buildRpcRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextRpcId(), method, ...(params ? { params } : {}) };
}

/**
 * Single JSON-RPC call over plain HTTP POST. Used by the polling tiers of the
 * transport ladder and by the capability probe.
 */
export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch("/api/rpc2", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(buildRpcRequest(method, params)),
  });

  if (!res.ok) {
    throw new ApiError(res.status, `RPC ${method} failed: HTTP ${res.status}`, "/api/rpc2");
  }

  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) {
    const err = new ApiError(200, body.error.message, "/api/rpc2");
    (err as ApiError & { rpcCode?: number }).rpcCode = body.error.code;
    throw err;
  }
  return body.result as T;
}

/**
 * Does this server expose the RPC2 endpoint at all?
 *
 * `rpc.ping` is a real registered method, so a successful call proves both that
 * /api/rpc2 exists and that we are allowed to reach it. A 404/405 means the
 * server predates 1.0.7; a 401 means a private site is gating us.
 */
export async function probeRpc2(): Promise<boolean> {
  try {
    await rpcCall("rpc.ping");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.isAuthRequired) return false;
    return false;
  }
}
