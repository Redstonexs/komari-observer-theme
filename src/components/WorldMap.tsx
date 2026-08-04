/**
 * Dot-matrix world map showing where the fleet lives.
 *
 * The land mask is drawn to a canvas (thousands of dots would be far too many
 * DOM nodes) and node markers are an SVG overlay on top, so they stay
 * hit-testable and accessible. The canvas only repaints on resize or theme
 * change — never on a data tick.
 *
 * Positions come from the node's `region` field, which Komari stores as a free
 * text string that operators conventionally fill with an ISO-3166 alpha-2 code.
 * Anything unrecognised is simply not plotted rather than guessed at.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COUNTRY_LATLNG, LAND, REGION_ALIASES } from "@/assets/geo";
import { useAppStore } from "@/store/app";
import { useLiveFleet } from "@/hooks/useLiveNode";
import type { NodeInfo } from "@/api/types";

const ASPECT = LAND.width / LAND.height;
const LON_SPAN = LAND.lonMax - LAND.lonMin;
const LAT_SPAN = LAND.latMax - LAND.latMin;

/** Decodes the bit-packed land mask once per module load. */
const landBits: Uint8Array = (() => {
  const binary = atob(LAND.mask);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
})();

const isLand = (col: number, row: number) => {
  const index = row * LAND.width + col;
  return (landBits[index >> 3]! >> (index & 7)) & 1;
};

/** Normalises an operator-typed region string to an ISO alpha-2 code. */
export function normalizeRegion(region: string): string | null {
  const code = region.trim().toUpperCase();
  if (!code) return null;
  const resolved = REGION_ALIASES[code] ?? code;
  return COUNTRY_LATLNG[resolved] ? resolved : null;
}

interface Cluster {
  code: string;
  lat: number;
  lon: number;
  nodes: NodeInfo[];
}

export function WorldMap() {
  const { t } = useTranslation();
  const nodes = useAppStore((s) => s.nodes);
  const setSearch = useAppStore((s) => s.setSearch);
  const maxHeight = useAppStore((s) => s.settings.map_height);
  const dark = useAppStore((s) => s.resolvedDark);
  const accent = useAppStore((s) => s.settings.accent);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Cluster | null>(null);

  /** One marker per country, not per node — a dozen nodes in Hong Kong should
   *  be one dot, not twelve stacked on the same pixel. */
  const clusters = useMemo(() => {
    const byCode = new Map<string, Cluster>();
    for (const node of nodes) {
      const code = normalizeRegion(node.region ?? "");
      if (!code) continue;
      const existing = byCode.get(code);
      if (existing) {
        existing.nodes.push(node);
      } else {
        const [lat, lon] = COUNTRY_LATLNG[code]!;
        byCode.set(code, { code, lat, lon, nodes: [node] });
      }
    }
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [nodes]);

  /* ---- Size: fill the width, but cap the height and letterbox ------- */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const available = host.clientWidth;
      // A 2.7:1 world map across a 1500px column would be nearly 600px tall and
      // push every node card below the fold, so height is the constraint and
      // the map centres itself in whatever width is left over.
      const h = Math.min(maxHeight, available / ASPECT);
      setSize({ w: Math.round(h * ASPECT), h: Math.round(h) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [maxHeight]);

  /* ---- Paint the land dots ------------------------------------------ */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const styles = getComputedStyle(document.documentElement);
    const dotColour = styles.getPropertyValue("--observer-map-dot").trim();
    const stepX = size.w / LAND.width;
    const stepY = size.h / LAND.height;
    // Slightly under half the cell so neighbouring dots stay visually separate.
    const radius = Math.max(0.6, Math.min(stepX, stepY) * 0.34);

    ctx.fillStyle = dotColour;
    for (let row = 0; row < LAND.height; row++) {
      for (let col = 0; col < LAND.width; col++) {
        if (!isLand(col, row)) continue;
        ctx.beginPath();
        ctx.arc((col + 0.5) * stepX, (row + 0.5) * stepY, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [size.w, size.h, dark, accent]);

  /* ---- Marker status, updated imperatively on each tick -------------- */
  const markerRefs = useRef(new Map<string, SVGGElement | null>());
  useLiveFleet((snapshot) => {
    for (const cluster of clusters) {
      const el = markerRefs.current.get(cluster.code);
      if (!el) continue;
      let online = 0;
      for (const node of cluster.nodes) {
        if (snapshot[node.uuid]?.online) online++;
      }
      const status =
        online === 0 ? "offline" : online === cluster.nodes.length ? "online" : "warn";
      if (el.dataset.status !== status) el.dataset.status = status;
      const label = el.querySelector("[data-count]");
      if (label) label.textContent = `${online}/${cluster.nodes.length}`;
    }
  });

  if (clusters.length === 0) return null;

  const project = (lat: number, lon: number) => ({
    x: ((lon - LAND.lonMin) / LON_SPAN) * size.w,
    // Clamp so a node in Svalbard or southern Chile still lands on the canvas.
    y: Math.max(6, Math.min(size.h - 6, ((LAND.latMax - lat) / LAT_SPAN) * size.h)),
  });

  const positioned = clusters.map((cluster) => ({
    cluster,
    ...project(cluster.lat, cluster.lon),
  }));

  /**
   * Country codes sit above their marker, so neighbours collide — NL over DE in
   * western Europe is the usual casualty. Rather than ship unreadable overlap,
   * keep the label on the busier cluster and let the crowded ones fade in on
   * hover, where they have the space to themselves.
   */
  const labelled = new Set<string>();
  const byCount = [...positioned].sort(
    (a, b) =>
      b.cluster.nodes.length - a.cluster.nodes.length ||
      a.cluster.code.localeCompare(b.cluster.code),
  );
  for (const candidate of byCount) {
    const clash = positioned.some(
      (other) =>
        labelled.has(other.cluster.code) &&
        Math.abs(candidate.x - other.x) < 22 &&
        Math.abs(candidate.y - other.y) < 14,
    );
    if (!clash) labelled.add(candidate.cluster.code);
  }

  return (
    <div className="observer-map panel" ref={hostRef}>
      <div className="observer-map-inner" style={{ width: size.w, height: size.h }}>
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} aria-hidden="true" />

        <svg
          className="observer-map-markers"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          role="img"
          aria-label={t("map.label", { count: clusters.length })}
        >
          {positioned.map(({ cluster, x, y }) => {
            // Grows with node count but flattens quickly, so one busy region
            // does not swamp the map.
            const r = 3.5 + Math.min(4, Math.log2(cluster.nodes.length + 1) * 2);
            return (
              <g
                key={cluster.code}
                ref={(el) => {
                  markerRefs.current.set(cluster.code, el);
                }}
                className="observer-marker"
                data-status="offline"
                transform={`translate(${x} ${y})`}
                tabIndex={0}
                role="button"
                aria-label={`${cluster.code}: ${cluster.nodes.length}`}
                onMouseEnter={() => setHover(cluster)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(cluster)}
                onBlur={() => setHover(null)}
                onClick={() => setSearch(cluster.code)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSearch(cluster.code);
                  }
                }}
              >
                <circle className="observer-marker-halo" r={r + 5} />
                <circle className="observer-marker-dot" r={r} />
                <text
                  className="observer-marker-code"
                  data-crowded={!labelled.has(cluster.code) || undefined}
                  y={-r - 7}
                  textAnchor="middle"
                >
                  {cluster.code}
                </text>
                {/* Rendered but visually hidden until hover — keeps the map calm
                    while still exposing the count to screen readers. */}
                <text className="observer-marker-count" data-count y={r + 12} textAnchor="middle">
                  0/{cluster.nodes.length}
                </text>
              </g>
            );
          })}
        </svg>

        {hover && (
          <div
            className="observer-map-tip panel panel-raised chrome"
            style={{
              left: project(hover.lat, hover.lon).x,
              top: project(hover.lat, hover.lon).y,
            }}
          >
            <strong>{hover.code}</strong>
            <ul>
              {hover.nodes.slice(0, 8).map((node) => (
                <li key={node.uuid}>{node.name}</li>
              ))}
              {hover.nodes.length > 8 && <li>+{hover.nodes.length - 8}</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
