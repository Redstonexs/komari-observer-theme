/**
 * Type definitions for Komari's public API surface.
 *
 * Sourced from the Go structs, not from documentation:
 *   - `models.Client`        -> database/models/models.go   (GET /api/nodes)
 *   - `models.Record`        -> database/models/models.go   (GET /api/records/load)
 *   - `protocol/v1.Report`   -> protocol/v1/report.go       (WS /api/clients, GET /api/recent/:uuid)
 *   - `GetPublicInfo()`      -> database/utils.go           (GET /api/public)
 *   - route table            -> web/router/router.go
 */

/* ------------------------------------------------------------------ *
 * Response envelope
 * ------------------------------------------------------------------ */

/**
 * Standard envelope produced by `renderStandard` in web/rpc/jsonrpc/bridge.go.
 * `data` is omitted entirely when the RPC result is nil.
 *
 * GET /api/me is the one public exception — it is bound with WithRaw() and
 * returns a bare object with no envelope.
 */
export interface Envelope<T> {
  status: "success" | "error";
  message?: string;
  data?: T;
}

/* ------------------------------------------------------------------ *
 * GET /api/public
 * ------------------------------------------------------------------ */

export interface PublicSettings {
  sitename: string;
  description: string;
  custom_head: string;
  custom_body: string;
  oauth_enable: boolean;
  oauth_provider: string;
  disable_password_login: boolean;
  cors_origin_check_enabled: boolean;
  /** Derived from metric-store retention, not a raw setting. */
  record_enabled: boolean;
  /** Hours. Same value as ping_record_preserve_time — they are not independent. */
  record_preserve_time: number;
  ping_record_preserve_time: number;
  private_site: boolean;
  visitor_audit_enabled: boolean;
  /** `short` name of the active theme. */
  theme: string;
  /**
   * Already a parsed object — do NOT JSON.parse it. Keys are exactly the `key`
   * values declared in komari-theme.json. The backend performs no type
   * validation on what the admin panel writes, so every value must be coerced.
   */
  theme_settings: Record<string, unknown>;
  /** Present on newer servers only. */
  metric_retention_days?: number;
}

/* ------------------------------------------------------------------ *
 * GET /api/me  (raw, no envelope)
 * ------------------------------------------------------------------ */

export interface Me {
  username: string;
  logged_in: boolean;
  /** Absent entirely for guests — not empty strings. */
  uuid?: string;
  sso_type?: string;
  sso_id?: string;
  "2fa_enabled"?: boolean;
}

/* ------------------------------------------------------------------ *
 * GET /api/nodes  — static metadata (models.Client)
 * ------------------------------------------------------------------ */

export interface NodeInfo {
  uuid: string;
  name: string;
  cpu_name: string;
  virtualization: string;
  arch: string;
  cpu_cores: number;
  cpu_physical_cores: number;
  os: string;
  kernel_version: string;
  gpu_name: string;
  region: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  weight: number;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  /** Nullable in Go (`*time.Time`). */
  expired_at: string | null;
  group: string;
  /** Semicolon-delimited, not an array. */
  tags: string;
  hidden: boolean;
  traffic_limit: number;
  traffic_limit_type: string;
  public_remark?: string;
  created_at: string;
  updated_at: string;
  // token / ipv4 / ipv6 / remark / version are stripped for guests.
}

/* ------------------------------------------------------------------ *
 * WS /api/clients and GET /api/recent/:uuid  — NESTED shape (v1.Report)
 * ------------------------------------------------------------------ */

export interface V1Report {
  /** Blanked by the server on the WS channel — identity comes from the map key. */
  uuid?: string;
  cpu: { name?: string; cores?: number; arch?: string; usage?: number };
  ram: { total: number; used: number };
  swap: { total: number; used: number };
  load: { load1: number; load5: number; load15: number };
  disk: { total: number; used: number };
  network: { up: number; down: number; totalUp: number; totalDown: number };
  connections: { tcp: number; udp: number };
  gpu?: {
    count: number;
    average_usage: number;
    detailed_info: Array<{
      name: string;
      memory_total: number;
      memory_used: number;
      utilization: number;
      temperature: number;
    }>;
  };
  uptime: number;
  process: number;
  message: string;
  method?: string;
  updated_at: string;
}

/** Frame written by web/api/ws.go after the client sends "get". */
export interface ClientsWsFrame {
  status: "success" | "error";
  error?: string;
  data: {
    /** UUIDs with a live agent connection. Authoritative for online-ness. */
    online: string[];
    /** Last report per UUID — may be stale for offline nodes. */
    data: Record<string, V1Report>;
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/records/load  — FLAT shape (models.Record)
 * ------------------------------------------------------------------ */

export interface LoadRecord {
  client: string;
  time: string;
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  load: number;
  temp: number;
  disk: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  traffic_up: number;
  traffic_down: number;
  process: number;
  connections: number;
  connections_udp: number;
  // `uptime` is commented out of the Go struct — no historical uptime exists.
}

export interface GpuDeviceRecord {
  client: string;
  time: string;
  device_index: number;
  device_name: string;
  mem_total: number;
  mem_used: number;
  utilization: number;
  temperature: number;
}

export interface LoadRecordsResponse {
  records: LoadRecord[];
  count: number;
  load_type?: string;
  has_gpu_data?: boolean;
  /** Keyed by stringified device index. */
  gpu_devices?: Record<
    string,
    { device_index: number; device_name: string; records: GpuDeviceRecord[] }
  >;
}

/**
 * Values accepted by ?load_type=.
 *
 * NOTE "gpu" is deliberately absent: the server's allowlist in
 * web/rpc/jsonrpc/public.go omits it and returns HTTP 400, even though the
 * downstream filter handles it. To read GPU history, omit load_type and use
 * the `gpu_devices` field.
 */
export type LoadType =
  | "cpu"
  | "ram"
  | "swap"
  | "load"
  | "temp"
  | "disk"
  | "network"
  | "process"
  | "connections"
  | "all";

/* ------------------------------------------------------------------ *
 * GET /api/records/ping and GET /api/task/ping
 * ------------------------------------------------------------------ */

export interface PingRecord {
  client: string;
  task_id: number;
  time: string;
  /** Latency in ms. A NEGATIVE value means packet loss — render as a gap. */
  value: number;
}

export interface PingTaskSummary {
  task_id: number;
  task_name?: string;
  loss?: number;
  min?: number;
  max?: number;
  avg?: number;
  total?: number;
}

export interface PingRecordsResponse {
  count: number;
  records: PingRecord[];
  tasks?: PingTaskSummary[];
  basic_info?: unknown;
}

export interface PublicPingTask {
  id: number;
  weight: number;
  name: string;
  clients: string[];
  default_on: boolean;
  /** icmp | tcp | http. The probe `target` is never exposed publicly. */
  type: string;
  /** Seconds. */
  interval: number;
}

/* ------------------------------------------------------------------ *
 * GET /api/version
 * ------------------------------------------------------------------ */

export interface VersionInfo {
  /** Defaults to "0.0.1" in a source build — do not assume valid semver. */
  version: string;
  hash: string;
}
