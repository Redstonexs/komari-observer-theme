/**
 * Resolves this theme's configuration.
 *
 * Values arrive in /api/public as `theme_settings`. Two things make that
 * untrustworthy:
 *
 *   1. The backend does zero type validation on what the admin panel POSTs, so
 *      a `number` field can arrive as "320" and a `switch` as "true".
 *   2. Server-side default merging only happens for an installed, non-default,
 *      managed theme whose komari-theme.json is present on disk — during local
 *      development against a dev server, none of that applies.
 *
 * So every key is coerced and defaulted here, and DEFAULTS is the single source
 * of truth that must stay in sync with komari-theme.json.
 */

import { bool, num, str } from "@/api/model";
import type { TierId } from "@/transport/types";

export type ViewMode = "grid" | "table" | "compact";
export type Density = "comfortable" | "compact" | "spacious";
export type Appearance = "light" | "dark" | "system";
export type BackgroundMode = "none" | "image" | "video" | "aurora" | "starfield" | "grid";
export type OfflinePosition = "keep" | "first" | "last";
export type AccentName = "cyan" | "ice" | "mint" | "amber" | "violet" | "rose";
export type LossSensitivity = "strict" | "standard" | "relaxed";

export interface ThemeSettings {
  // View
  default_view: ViewMode;
  card_min_width: number;
  offline_position: OfflinePosition;
  max_width: number;
  show_stat_bar: boolean;
  // Appearance
  default_appearance: Appearance;
  accent: AccentName;
  density: Density;
  // Background
  bg_mode: BackgroundMode;
  bg_image_dark: string;
  bg_image_light: string;
  bg_video: string;
  bg_blur: number;
  bg_overlay: number;
  bg_fixed: boolean;
  allow_visitor_background: boolean;
  // Motion
  enable_boot_sequence: boolean;
  enable_grid_overlay: boolean;
  enable_glow: boolean;
  enable_scramble: boolean;
  enable_pulse: boolean;
  // Data
  update_interval: number;
  transport_preference: "auto" | TierId;
  sse_endpoint: string;
  show_connection_badge: boolean;
  loss_sensitivity: LossSensitivity;
  // Privacy
  show_billing: boolean;
  footer_text: string;
}

export const DEFAULTS: ThemeSettings = {
  default_view: "grid",
  card_min_width: 320,
  offline_position: "last",
  max_width: 1600,
  show_stat_bar: true,

  default_appearance: "system",
  accent: "cyan",
  density: "comfortable",

  bg_mode: "aurora",
  bg_image_dark: "",
  bg_image_light: "",
  bg_video: "",
  bg_blur: 0,
  bg_overlay: 40,
  bg_fixed: true,
  allow_visitor_background: true,

  enable_boot_sequence: true,
  enable_grid_overlay: true,
  enable_glow: true,
  enable_scramble: true,
  enable_pulse: true,

  update_interval: 2,
  transport_preference: "auto",
  sse_endpoint: "",
  show_connection_badge: true,
  loss_sensitivity: "standard",

  show_billing: true,
  footer_text: "",
};

/** Picks `value` when it is one of `allowed`, else the default. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof value === "string" ? value.trim() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Older servers (< 1.0.5) never parsed `configuration` at all and some proxies
 * have been observed handing back a JSON string. Tolerate object, string, and
 * a settings-flattened-onto-the-root layout.
 */
function extract(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function resolveSettings(themeSettings: unknown): ThemeSettings {
  const s = extract(themeSettings);
  const d = DEFAULTS;

  return {
    default_view: oneOf(s.default_view, ["grid", "table", "compact"] as const, d.default_view),
    card_min_width: clamp(num(s.card_min_width, d.card_min_width), 200, 720),
    offline_position: oneOf(
      s.offline_position,
      ["keep", "first", "last"] as const,
      d.offline_position,
    ),
    // 0 is meaningful here (full bleed), so only clamp the upper bound.
    max_width: clamp(num(s.max_width, d.max_width), 0, 4000),
    show_stat_bar: bool(s.show_stat_bar, d.show_stat_bar),

    default_appearance: oneOf(
      s.default_appearance,
      ["light", "dark", "system"] as const,
      d.default_appearance,
    ),
    accent: oneOf(
      s.accent,
      ["cyan", "ice", "mint", "amber", "violet", "rose"] as const,
      d.accent,
    ),
    density: oneOf(s.density, ["comfortable", "compact", "spacious"] as const, d.density),

    bg_mode: oneOf(
      s.bg_mode,
      ["none", "image", "video", "aurora", "starfield", "grid"] as const,
      d.bg_mode,
    ),
    bg_image_dark: str(s.bg_image_dark, d.bg_image_dark).trim(),
    bg_image_light: str(s.bg_image_light, d.bg_image_light).trim(),
    bg_video: str(s.bg_video, d.bg_video).trim(),
    bg_blur: clamp(num(s.bg_blur, d.bg_blur), 0, 60),
    bg_overlay: clamp(num(s.bg_overlay, d.bg_overlay), -100, 100),
    bg_fixed: bool(s.bg_fixed, d.bg_fixed),
    allow_visitor_background: bool(s.allow_visitor_background, d.allow_visitor_background),

    enable_boot_sequence: bool(s.enable_boot_sequence, d.enable_boot_sequence),
    enable_grid_overlay: bool(s.enable_grid_overlay, d.enable_grid_overlay),
    enable_glow: bool(s.enable_glow, d.enable_glow),
    enable_scramble: bool(s.enable_scramble, d.enable_scramble),
    enable_pulse: bool(s.enable_pulse, d.enable_pulse),

    // Floor at 1s: the server needs ~11s to mark an agent offline, so anything
    // faster is pure traffic with no extra signal.
    update_interval: clamp(num(s.update_interval, d.update_interval), 1, 60),
    transport_preference: oneOf(
      s.transport_preference,
      ["auto", "rpc2-ws", "clients-ws", "sse", "rpc2-http", "recent-http"] as const,
      d.transport_preference,
    ),
    sse_endpoint: str(s.sse_endpoint, d.sse_endpoint).trim(),
    show_connection_badge: bool(s.show_connection_badge, d.show_connection_badge),
    loss_sensitivity: oneOf(
      s.loss_sensitivity,
      ["strict", "standard", "relaxed"] as const,
      d.loss_sensitivity,
    ),

    show_billing: bool(s.show_billing, d.show_billing),
    footer_text: str(s.footer_text, d.footer_text),
  };
}

/** Packet-loss thresholds for the degraded / bad status colours, in percent. */
export const LOSS_THRESHOLDS: Record<LossSensitivity, { warn: number; bad: number }> = {
  strict: { warn: 3, bad: 9 },
  standard: { warn: 5, bad: 12 },
  relaxed: { warn: 10, bad: 25 },
};
