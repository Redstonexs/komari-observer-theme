/**
 * Structural application state.
 *
 * Everything here changes rarely — site config, node metadata, view
 * preferences, connection status. Per-tick telemetry lives in `liveBus` and
 * never touches this store.
 */

import { create } from "zustand";
import type { Me, NodeInfo, PublicSettings } from "@/api/types";
import type { LinkStatus } from "@/transport/supervisor";
import { DEFAULTS, type Appearance, type ThemeSettings, type ViewMode } from "@/config/settings";

export type SortKey = "default" | "name" | "cpu" | "memory" | "disk" | "network" | "uptime";

const LS_VIEW = "observer:view";
const LS_SORT = "observer:sort";
const LS_APPEARANCE = "appearance"; // documented Komari key
const LS_BACKGROUND = "observer:background";

interface AppState {
  // Bootstrap
  ready: boolean;
  bootError: string | null;
  /** True when the site is private and we are not logged in. */
  needsLogin: boolean;

  publicSettings: PublicSettings | null;
  settings: ThemeSettings;
  me: Me | null;
  nodes: NodeInfo[];
  serverVersion: string;

  // Connection
  link: LinkStatus;

  // View preferences (visitor-local, seeded from theme settings)
  view: ViewMode;
  sort: SortKey;
  sortDesc: boolean;
  search: string;
  group: string | null;
  appearance: Appearance;
  resolvedDark: boolean;
  /** Visitor background override, when the operator allows it. */
  backgroundOverride: string | null;

  setBootstrap(data: {
    publicSettings: PublicSettings;
    settings: ThemeSettings;
    me: Me;
    nodes: NodeInfo[];
    serverVersion: string;
  }): void;
  setBootError(message: string): void;
  setNeedsLogin(value: boolean): void;
  setNodes(nodes: NodeInfo[]): void;
  setLink(link: LinkStatus): void;
  setView(view: ViewMode): void;
  setSort(sort: SortKey, desc?: boolean): void;
  setSearch(search: string): void;
  setGroup(group: string | null): void;
  setAppearance(appearance: Appearance): void;
  syncResolvedDark(): void;
  setBackgroundOverride(value: string | null): void;
}

function readLocal(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    // Some themes JSON-encode `appearance`; accept both forms.
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private browsing / storage disabled */
  }
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(appearance: Appearance): boolean {
  return appearance === "dark" || (appearance === "system" && prefersDark());
}

const initialLink: LinkStatus = {
  state: "connecting",
  tier: null,
  label: "—",
  lastGoodAt: 0,
  degraded: false,
  lastError: null,
};

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  needsLogin: false,

  publicSettings: null,
  settings: DEFAULTS,
  me: null,
  nodes: [],
  serverVersion: "",

  link: initialLink,

  view: (readLocal(LS_VIEW) as ViewMode | null) ?? DEFAULTS.default_view,
  sort: (readLocal(LS_SORT) as SortKey | null) ?? "default",
  sortDesc: false,
  search: "",
  group: null,
  appearance: (readLocal(LS_APPEARANCE) as Appearance | null) ?? DEFAULTS.default_appearance,
  resolvedDark: resolveDark((readLocal(LS_APPEARANCE) as Appearance | null) ?? "system"),
  backgroundOverride: readLocal(LS_BACKGROUND),

  setBootstrap: ({ publicSettings, settings, me, nodes, serverVersion }) => {
    // Visitor choices win over the operator default; theme settings only seed
    // the first visit.
    const storedView = readLocal(LS_VIEW) as ViewMode | null;
    const storedAppearance = readLocal(LS_APPEARANCE) as Appearance | null;
    const appearance = storedAppearance ?? settings.default_appearance;

    set({
      publicSettings,
      settings,
      me,
      nodes,
      serverVersion,
      ready: true,
      bootError: null,
      view: storedView ?? settings.default_view,
      appearance,
      resolvedDark: resolveDark(appearance),
    });
  },

  setBootError: (message) => set({ bootError: message, ready: true }),
  setNeedsLogin: (value) => set({ needsLogin: value }),
  setNodes: (nodes) => set({ nodes }),
  setLink: (link) => set({ link }),

  setView: (view) => {
    writeLocal(LS_VIEW, view);
    set({ view });
  },

  setSort: (sort, desc) => {
    const next = desc ?? (get().sort === sort ? !get().sortDesc : false);
    writeLocal(LS_SORT, sort);
    set({ sort, sortDesc: next });
  },

  setSearch: (search) => set({ search }),
  setGroup: (group) => set({ group }),

  setAppearance: (appearance) => {
    writeLocal(LS_APPEARANCE, appearance);
    set({ appearance, resolvedDark: resolveDark(appearance) });
  },

  syncResolvedDark: () => set({ resolvedDark: resolveDark(get().appearance) }),

  setBackgroundOverride: (value) => {
    writeLocal(LS_BACKGROUND, value);
    set({ backgroundOverride: value });
  },
}));
