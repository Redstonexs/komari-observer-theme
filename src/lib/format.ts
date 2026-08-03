/** Formatting helpers. All output is ASCII-stable so tabular-nums keeps columns aligned. */

const BYTE_UNITS = ["B", "K", "M", "G", "T", "P"] as const;

/** Compact byte size, e.g. 4.2G. Binary (1024) — these are memory/disk figures. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** i;
  // Drop the decimal once we are into 3-digit territory; the extra digit adds
  // width without adding information.
  return `${value.toFixed(i === 0 || value >= 100 ? 0 : digits)}${BYTE_UNITS[i]}`;
}

/** Network rate. Decimal (1000) to match how link speeds are quoted. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1000)), units.length - 1);
  const value = bytesPerSecond / 1000 ** i;
  return `${value.toFixed(i === 0 || value >= 100 ? 0 : 1)}${units[i]}`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "0.0";
  return value.toFixed(digits);
}

/** Uptime as the largest two units, e.g. "12d 4h". */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Relative age of a timestamp, for staleness indicators. */
export function formatAge(epochMs: number, now = Date.now()): string {
  if (!epochMs) return "never";
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms >= 100 ? String(Math.round(ms)) : ms.toFixed(1);
}

/** `tags` is a semicolon-delimited string in models.Client, not an array. */
export function parseTags(tags: string): string[] {
  return tags
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function formatPrice(price: number, currency: string, cycle: number): string {
  if (!price) return "";
  const period =
    cycle >= 365 ? "/yr" : cycle >= 30 ? "/mo" : cycle >= 7 ? "/wk" : cycle > 0 ? `/${cycle}d` : "";
  return `${currency || "$"}${price}${period}`;
}

/** Days until expiry; negative means already expired. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}
