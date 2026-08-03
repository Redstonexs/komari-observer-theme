/**
 * The canonical live record every transport normalizes into.
 *
 * Komari exposes the same telemetry in two incompatible layouts:
 *
 *   NESTED  (protocol/v1.Report)  — WS /api/clients, GET /api/recent/:uuid
 *                                   cpu.usage, ram.total, network.totalUp, ...
 *   FLAT    (recordLike)          — rpc2 common:getNodesLatestStatus
 *                                   cpu, ram_total, net_total_up, ...
 *
 * The flat shape is a strict superset: it additionally carries `online`,
 * `temp`, `load5`, `load15` and per-task `ping` stats. So flat is the canonical
 * form and the nested shape is up-converted into it.
 *
 * Field names below mirror Go's `recordLike` in web/rpc/jsonrpc/common.go so
 * that the richest transport needs no translation at all.
 */

import type { V1Report } from "./types";

/** Per-ping-task stats, present only on the rpc2 transports. */
export interface PingStat {
  name: string;
  /** Most recent latency, ms. */
  latest: number;
  avg: number;
  /** (P99-P50)/P50 — jitter/tail indicator. */
  tail: number;
  /** Packet loss, percent. */
  loss: number;
  min: number;
  max: number;
}

export interface LiveRecord {
  /** Node UUID. On the WS channel this comes from the map key, not the payload. */
  client: string;
  /** True only when the agent currently holds a connection. */
  online: boolean;

  /** Percent, 0-100. The server floors this at 0.01 so idle != "no data". */
  cpu: number;
  /** Average GPU utilisation percent across devices. 0 when absent. */
  gpu: number;

  /** Bytes. */
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number;
  disk_total: number;

  load: number;
  load5: number;
  load15: number;
  /** Celsius. Not available on the legacy WS channel — 0 there. */
  temp: number;

  /** Bytes per second. */
  net_in: number;
  net_out: number;
  /** Cumulative bytes since agent start. */
  net_total_up: number;
  net_total_down: number;

  process: number;
  connections: number;
  connections_udp: number;

  /** Seconds. */
  uptime: number;
  /** Agent-supplied status line. */
  message: string;
  /** Epoch milliseconds. */
  time: number;

  /** Keyed by ping task id. Only the rpc2 transports populate this. */
  ping?: Record<string, PingStat>;
}

/** UUID-keyed snapshot of the whole fleet, as produced by every transport. */
export type LiveSnapshot = Record<string, LiveRecord>;

/* ------------------------------------------------------------------ *
 * Coercion helpers
 *
 * The wire is not trustworthy: numbers occasionally arrive as strings, older
 * servers omit fields entirely, and theme settings are stored with no type
 * validation at all. Everything is coerced rather than asserted.
 * ------------------------------------------------------------------ */

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0" || value === "") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Epoch ms from an RFC3339 string, a number, or nothing. */
function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string" && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

function emptyRecord(client: string, online: boolean, now: number): LiveRecord {
  return {
    client,
    online,
    cpu: 0,
    gpu: 0,
    ram: 0,
    ram_total: 0,
    swap: 0,
    swap_total: 0,
    disk: 0,
    disk_total: 0,
    load: 0,
    load5: 0,
    load15: 0,
    temp: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    uptime: 0,
    message: "",
    time: now,
  };
}

/* ------------------------------------------------------------------ *
 * NESTED -> canonical
 * ------------------------------------------------------------------ */

/**
 * Up-converts one protocol/v1.Report.
 *
 * `online` must be supplied by the caller: the nested payload has no such
 * field, and presence in the report map does NOT imply the node is up — the
 * server keeps serving the last known report for offline nodes.
 *
 * Direction mapping is the easy thing to get backwards:
 *   network.up   = outbound = net_out
 *   network.down = inbound  = net_in
 */
export function fromV1Report(
  client: string,
  report: V1Report,
  online: boolean,
  now = Date.now(),
): LiveRecord {
  return {
    client,
    online,
    cpu: num(report.cpu?.usage),
    gpu: num(report.gpu?.average_usage),
    ram: num(report.ram?.used),
    ram_total: num(report.ram?.total),
    swap: num(report.swap?.used),
    swap_total: num(report.swap?.total),
    disk: num(report.disk?.used),
    disk_total: num(report.disk?.total),
    load: num(report.load?.load1),
    load5: num(report.load?.load5),
    load15: num(report.load?.load15),
    // v1.Report carries no temperature. GPU temps exist per-device, but a
    // fleet-wide CPU temp does not — leave 0 rather than inventing one.
    temp: 0,
    net_in: num(report.network?.down),
    net_out: num(report.network?.up),
    net_total_up: num(report.network?.totalUp),
    net_total_down: num(report.network?.totalDown),
    process: num(report.process),
    connections: num(report.connections?.tcp),
    connections_udp: num(report.connections?.udp),
    uptime: num(report.uptime),
    message: str(report.message),
    time: toEpochMs(report.updated_at, now),
  };
}

/**
 * Normalizes a whole WS /api/clients frame body.
 *
 * Online-ness comes from the `online` array, never from key presence in
 * `data`. Nodes that are online but have not reported yet still get an entry
 * so the UI can show them as up with empty metrics.
 */
export function fromClientsFrame(body: {
  online?: string[];
  data?: Record<string, V1Report>;
}): LiveSnapshot {
  const now = Date.now();
  const onlineSet = new Set(body.online ?? []);
  const out: LiveSnapshot = {};

  for (const [uuid, report] of Object.entries(body.data ?? {})) {
    out[uuid] = fromV1Report(uuid, report, onlineSet.has(uuid), now);
  }
  for (const uuid of onlineSet) {
    if (!out[uuid]) out[uuid] = emptyRecord(uuid, true, now);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * FLAT (rpc2 recordLike) -> canonical
 * ------------------------------------------------------------------ */

function fromRecordLike(raw: Record<string, unknown>, key: string, now: number): LiveRecord {
  const ping = raw.ping;
  return {
    client: str(raw.client) || key,
    online: bool(raw.online),
    cpu: num(raw.cpu),
    gpu: num(raw.gpu),
    ram: num(raw.ram),
    ram_total: num(raw.ram_total),
    swap: num(raw.swap),
    swap_total: num(raw.swap_total),
    disk: num(raw.disk),
    disk_total: num(raw.disk_total),
    load: num(raw.load),
    load5: num(raw.load5),
    load15: num(raw.load15),
    temp: num(raw.temp),
    net_in: num(raw.net_in),
    net_out: num(raw.net_out),
    net_total_up: num(raw.net_total_up),
    net_total_down: num(raw.net_total_down),
    process: num(raw.process),
    connections: num(raw.connections),
    connections_udp: num(raw.connections_udp),
    uptime: num(raw.uptime),
    message: str(raw.message),
    time: toEpochMs(raw.time, now),
    ...(ping && typeof ping === "object"
      ? { ping: normalizePing(ping as Record<string, unknown>) }
      : {}),
  };
}

function normalizePing(raw: Record<string, unknown>): Record<string, PingStat> {
  const out: Record<string, PingStat> = {};
  for (const [taskId, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    out[taskId] = {
      name: str(s.name),
      latest: num(s.latest),
      avg: num(s.avg),
      tail: num(s.tail),
      loss: num(s.loss),
      min: num(s.min),
      max: num(s.max),
    };
  }
  return out;
}

/**
 * Normalizes the result of `common:getNodesLatestStatus`.
 *
 * Accepts either a uuid-keyed map or a bare array — the RPC returns a map, but
 * tolerating an array costs nothing and guards against shape drift between
 * server versions.
 */
export function fromLatestStatus(result: unknown): LiveSnapshot {
  const now = Date.now();
  const out: LiveSnapshot = {};
  if (!result || typeof result !== "object") return out;

  if (Array.isArray(result)) {
    for (const item of result) {
      if (!item || typeof item !== "object") continue;
      const rec = fromRecordLike(item as Record<string, unknown>, "", now);
      if (rec.client) out[rec.client] = rec;
    }
    return out;
  }

  for (const [uuid, item] of Object.entries(result as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    out[uuid] = fromRecordLike(item as Record<string, unknown>, uuid, now);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Derived values
 * ------------------------------------------------------------------ */

export const ratio = (used: number, total: number): number =>
  total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;

/** Percent 0-100 of a node's memory in use. */
export const memPercent = (r: LiveRecord) => ratio(r.ram, r.ram_total) * 100;
export const diskPercent = (r: LiveRecord) => ratio(r.disk, r.disk_total) * 100;
export const swapPercent = (r: LiveRecord) => ratio(r.swap, r.swap_total) * 100;
