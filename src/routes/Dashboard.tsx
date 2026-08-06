import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useAppStore, type SortKey } from "@/store/app";
import { liveBus } from "@/store/live";
import { useFleetStructure, useLiveNode } from "@/hooks/useLiveNode";
import { Meter, type MeterHandle } from "@/components/Meter";
import { NodeCard } from "@/components/NodeCard";
import { RegionTag } from "@/components/RegionTag";
import { StatBar } from "@/components/StatBar";
import { WorldMap } from "@/components/WorldMap";
import { Flip, gsap, hasTarget, reducedMotion, revealCards } from "@/anim/gsap";
import { diskPercent, memPercent } from "@/api/model";
import { formatBytes, formatRate, formatUptime, parseTags } from "@/lib/format";
import { regionCode } from "@/lib/region";
import type { NodeInfo } from "@/api/types";

export function Dashboard() {
  const { t } = useTranslation();
  const nodes = useAppStore((s) => s.nodes);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const sort = useAppStore((s) => s.sort);
  const sortDesc = useAppStore((s) => s.sortDesc);
  const setSort = useAppStore((s) => s.setSort);
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  const group = useAppStore((s) => s.group);
  const setGroup = useAppStore((s) => s.setGroup);
  const settings = useAppStore((s) => s.settings);

  // Re-run ordering when the fleet's shape changes. Metric churn deliberately
  // does NOT reorder the grid — cards swapping places every 2 seconds is
  // unusable, so sort is applied against the snapshot at structure-change time.
  const structure = useFleetStructure();

  const groups = useMemo(() => {
    const set = new Set(nodes.map((n) => n.group).filter(Boolean));
    return [...set].sort();
  }, [nodes]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    let list = nodes.filter((node) => {
      if (group && node.group !== group) return false;
      if (!query) return true;
      return (
        node.name.toLowerCase().includes(query) ||
        node.region?.toLowerCase().includes(query) ||
        // A region typed as a flag emoji carries no letters to match, so search
        // the country code it resolves to as well.
        regionCode(node.region ?? "")?.toLowerCase().includes(query) ||
        node.group?.toLowerCase().includes(query) ||
        parseTags(node.tags).some((tag) => tag.toLowerCase().includes(query))
      );
    });

    list = [...list].sort((a, b) => compareNodes(a, b, sort, sortDesc));

    if (settings.offline_position !== "keep") {
      const offlineLast = settings.offline_position === "last";
      list.sort((a, b) => {
        const aOn = liveBus.get(a.uuid)?.online ? 1 : 0;
        const bOn = liveBus.get(b.uuid)?.online ? 1 : 0;
        if (aOn === bOn) return 0;
        return offlineLast ? bOn - aOn : aOn - bOn;
      });
    }
    return list;
    // `structure` participates so online/offline grouping re-evaluates.
  }, [nodes, search, group, sort, sortDesc, settings.offline_position, structure]);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const pendingFlip = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const orderKey = visible.map((n) => n.uuid).join(",");

  /**
   * Snapshots card positions BEFORE a reorder.
   *
   * This must be called from the event handler that triggers the change, never
   * during render. React state updates are async, so at handler time the DOM
   * still holds the pre-change layout — which is exactly what Flip needs.
   * Capturing during render instead produces garbage under StrictMode's double
   * invocation and strands every card under a leftover transform.
   */
  const captureFlip = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || reducedMotion()) return;
    pendingFlip.current = Flip.getState(grid.querySelectorAll("[data-node]"));
  }, []);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = grid.querySelectorAll<HTMLElement>("[data-node]");

    if (!pendingFlip.current) return;
    const state = pendingFlip.current;
    pendingFlip.current = null;

    // Drop any in-flight flip for these targets first; two overlapping flips
    // leave the loser's transform applied forever.
    if (!hasTarget(cards)) return;
    Flip.killFlipsOf(cards);
    Flip.from(state, {
      duration: 0.45,
      ease: "power2.inOut",
      absolute: true,
      onEnter: (els) => revealCards(els),
      // Flip works by applying a transform and animating it to zero. If it is
      // ever interrupted the transform sticks, so clear it explicitly.
      onComplete: () => {
        if (cards.length) gsap.set(cards, { clearProps: "transform" });
      },
    });
  }, [orderKey]);

  // One-time entrance. Deliberately separate from the flip path so a reorder
  // never re-plays it.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !gridRef.current || visible.length === 0) return;
    revealed.current = true;
    revealCards(gridRef.current.querySelectorAll("[data-node]"));
  }, [visible.length]);

  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${settings.card_min_width}px, 1fr))`,
  };

  return (
    <div className="observer-page">
      <StatBar />
      {settings.show_map && <WorldMap />}

      <div className="observer-toolbar">
        <input
          className="observer-search"
          type="search"
          value={search}
          placeholder={t("view.search")}
          onChange={(e) => { captureFlip(); setSearch(e.target.value); }}
          aria-label={t("view.search")}
        />

        {groups.length > 0 && (
          <select
            className="observer-select chrome"
            value={group ?? ""}
            onChange={(e) => { captureFlip(); setGroup(e.target.value || null); }}
            aria-label={t("view.allGroups")}
          >
            <option value="">{t("view.allGroups")}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}

        <select
          className="observer-select chrome"
          value={sort}
          onChange={(e) => { captureFlip(); setSort(e.target.value as SortKey, false); }}
          aria-label={t("view.sortBy")}
        >
          {(["default", "name", "cpu", "memory", "disk", "network", "uptime"] as SortKey[]).map(
            (key) => (
              <option key={key} value={key}>
                {t(`view.sort.${key}`)}
              </option>
            ),
          )}
        </select>

        <div className="observer-segmented">
          {(["grid", "table", "compact"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={view === mode}
              onClick={() => setView(mode)}
            >
              {t(`view.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      {nodes.length === 0 ? (
        <p className="observer-empty">{t("view.noNodes")}</p>
      ) : visible.length === 0 ? (
        <p className="observer-empty">{t("view.empty")}</p>
      ) : view === "table" ? (
        <NodeTable nodes={visible} />
      ) : (
        <div
          ref={gridRef}
          className="observer-grid"
          data-compact={view === "compact"}
          style={gridStyle}
        >
          {visible.map((node) => (
            <NodeCard key={node.uuid} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Sorted against the live bus, since metrics are not in React state. */
function compareNodes(a: NodeInfo, b: NodeInfo, key: SortKey, desc: boolean): number {
  const ra = liveBus.get(a.uuid);
  const rb = liveBus.get(b.uuid);
  let result = 0;

  switch (key) {
    case "name":
      result = a.name.localeCompare(b.name);
      break;
    case "cpu":
      result = (ra?.cpu ?? 0) - (rb?.cpu ?? 0);
      break;
    case "memory":
      result = (ra ? memPercent(ra) : 0) - (rb ? memPercent(rb) : 0);
      break;
    case "disk":
      result = (ra ? diskPercent(ra) : 0) - (rb ? diskPercent(rb) : 0);
      break;
    case "network":
      result =
        (ra ? ra.net_in + ra.net_out : 0) - (rb ? rb.net_in + rb.net_out : 0);
      break;
    case "uptime":
      result = (ra?.uptime ?? 0) - (rb?.uptime ?? 0);
      break;
    default:
      // Operator-defined ordering; `weight` is the admin's explicit intent.
      result = b.weight - a.weight || a.name.localeCompare(b.name);
      return result;
  }
  return desc ? -result : result;
}

/* ------------------------------------------------------------------ *
 * Table view
 * ------------------------------------------------------------------ */

function NodeTable({ nodes }: { nodes: NodeInfo[] }) {
  const { t } = useTranslation();
  return (
    <div className="observer-tablewrap panel">
      <table className="observer-table">
        <thead>
          <tr className="chrome">
            <th className="observer-th-status" />
            <th>{t("view.sort.name")}</th>
            <th>{t("card.cpu")}</th>
            <th>{t("card.memory")}</th>
            <th>{t("card.disk")}</th>
            <th>{t("card.network")}</th>
            <th>{t("card.uptime")}</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <NodeRow key={node.uuid} node={node} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeRow({ node }: { node: NodeInfo }) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  const cpuRef = useRef<HTMLSpanElement | null>(null);
  const memRef = useRef<HTMLSpanElement | null>(null);
  const diskRef = useRef<HTMLSpanElement | null>(null);
  const netRef = useRef<HTMLSpanElement | null>(null);
  const upRef = useRef<HTMLSpanElement | null>(null);
  const cpuMeter = useRef<MeterHandle | null>(null);
  const memMeter = useRef<MeterHandle | null>(null);
  const diskMeter = useRef<MeterHandle | null>(null);

  useLiveNode(node.uuid, (record) => {
    const row = rowRef.current;
    if (!row) return;
    const status = record?.online ? "online" : "offline";
    if (row.dataset.status !== status) row.dataset.status = status;

    if (!record || !record.online) {
      for (const ref of [cpuRef, memRef, diskRef, netRef, upRef]) {
        if (ref.current) ref.current.textContent = "—";
      }
      for (const meter of [cpuMeter, memMeter, diskMeter]) meter.current?.set(0);
      return;
    }
    const mem = memPercent(record);
    const disk = diskPercent(record);

    if (cpuRef.current) cpuRef.current.textContent = `${record.cpu.toFixed(1)}%`;
    if (memRef.current) {
      memRef.current.textContent = `${mem.toFixed(0)}% ${formatBytes(record.ram)}`;
    }
    if (diskRef.current) {
      diskRef.current.textContent = `${disk.toFixed(0)}% ${formatBytes(record.disk)}`;
    }
    cpuMeter.current?.set(record.cpu);
    memMeter.current?.set(mem);
    diskMeter.current?.set(disk);

    if (netRef.current) {
      netRef.current.textContent = `↑${formatRate(record.net_out)} ↓${formatRate(record.net_in)}`;
    }
    if (upRef.current) upRef.current.textContent = formatUptime(record.uptime);
  });

  return (
    <tr ref={rowRef} data-status="offline" data-node={node.uuid}>
      <td className="observer-th-status">
        <span className="status-dot" aria-hidden="true" />
      </td>
      <td>
        <Link to={`/node/${node.uuid}`} className="observer-table-name">
          {node.name}
        </Link>
        {node.region && (
          <RegionTag region={node.region} className="chrome observer-table-region" />
        )}
      </td>
      {/* The three ratio columns carry a bar under the figure — it is what makes
          a 100-row table scannable without reading every number. */}
      <td className="metric observer-td-meter">
        <span ref={cpuRef}>—</span>
        <Meter ref={cpuMeter} label={t("card.cpu")} />
      </td>
      <td className="metric observer-td-meter">
        <span ref={memRef}>—</span>
        <Meter ref={memMeter} label={t("card.memory")} />
      </td>
      <td className="metric observer-td-meter">
        <span ref={diskRef}>—</span>
        <Meter ref={diskMeter} label={t("card.disk")} />
      </td>
      <td className="metric">
        <span ref={netRef}>—</span>
      </td>
      <td className="metric">
        <span ref={upRef}>—</span>
      </td>
    </tr>
  );
}
