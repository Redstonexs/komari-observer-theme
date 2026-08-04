/**
 * Hand-rolled SVG line/area chart, drawn on with DrawSVGPlugin.
 *
 * Deliberately not a charting library: this theme needs exactly one chart
 * shape, and Recharts/ECharts would add 100-400 KB plus a visual language that
 * fights the rest of the design.
 *
 * `null` in a series means "no data here" and produces a real gap — which is
 * how packet loss must be rendered, since Komari encodes loss as a NEGATIVE
 * latency and plotting that as a value would be a lie.
 *
 * The hover readout snaps to a real sample rather than interpolating along the
 * path. Two reasons: an interpolated number is a number the server never
 * reported, and snapping means moving the pointer within one sample's zone
 * changes no state at all, so a 400-point chart re-renders a handful of times
 * across a sweep instead of once per mousemove.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap, reducedMotion } from "@/anim/gsap";

export interface Series {
  label: string;
  /** x is epoch ms; y of null breaks the line. */
  points: Array<{ x: number; y: number | null }>;
  /** CSS colour; defaults to the chart ramp slot for its index. */
  color?: string;
  filled?: boolean;
}

interface LineChartProps {
  series: Series[];
  height?: number;
  /** Force the y-axis ceiling (e.g. 100 for percentages). */
  maxY?: number;
  /** Formats the y-axis tick labels. */
  formatY?: (value: number) => string;
  /**
   * Formats the hover readout. Defaults to `formatY`, but an axis can afford to
   * round harder than a value the user is deliberately pointing at.
   */
  formatValue?: (value: number) => string;
  ariaLabel?: string;
}

const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

/**
 * How far, in CSS pixels, a series' nearest sample may sit from the cursor
 * before that series is dropped from the readout. Series do not share a time
 * axis — each ping task is probed on its own schedule and downsampled
 * independently — so "the value at this x" has to be resolved per series, and
 * a series whose data ended an hour ago must not report a stale figure.
 */
const HIT_PX = 14;

export function LineChart({
  series,
  height = 200,
  maxY,
  formatY = (v) => String(Math.round(v)),
  formatValue,
  ariaLabel,
}: LineChartProps) {
  const id = useId().replace(/:/g, "");
  const rootRef = useRef<SVGSVGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readout = formatValue ?? formatY;

  /**
   * The viewBox is measured rather than fixed so that one SVG unit equals one
   * CSS pixel.
   *
   * A fixed viewBox with preserveAspectRatio="none" is the obvious approach and
   * it silently destroys the axis labels: an 800-unit viewBox rendered into a
   * 380px column scales every glyph by 0.475, turning 9px text into ~4px. Text
   * inside SVG cannot opt out of that scaling.
   */
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const VIEW_W = width;

  /** Cursor position as an epoch ms snapped to a real sample; null when idle. */
  const [cursorX, setCursorX] = useState<number | null>(null);
  /** Only announce the readout when it is being driven from the keyboard —
   *  a polite live region firing on every mouse sweep is noise. */
  const [byKeyboard, setByKeyboard] = useState(false);

  const geometry = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y).filter((y): y is number => y != null);

    // Nothing to lay out until the container has been measured.
    if (xs.length === 0 || VIEW_W <= PAD_LEFT + PAD_RIGHT) return null;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    // Headroom above the peak so the line never touches the frame.
    const ceiling = maxY ?? Math.max(1, Math.max(...ys) * 1.15);
    const spanX = Math.max(1, maxX - minX);

    const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
    const plotH = height - PAD_TOP - PAD_BOTTOM;

    const sx = (x: number) => PAD_LEFT + ((x - minX) / spanX) * plotW;
    const sy = (y: number) => PAD_TOP + plotH - (Math.min(y, ceiling) / ceiling) * plotH;
    const unsx = (px: number) => minX + ((px - PAD_LEFT) / plotW) * spanX;

    const paths = series.map((s) => {
      let line = "";
      let open = false;
      for (const point of s.points) {
        if (point.y == null) {
          // Close the current run; the next real value starts a new subpath.
          open = false;
          continue;
        }
        line += `${open ? "L" : "M"}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`;
        open = true;
      }

      let area = "";
      if (s.filled) {
        // Build the fill per contiguous run so gaps stay empty.
        let run: Array<{ x: number; y: number }> = [];
        const flush = () => {
          if (run.length > 1) {
            const first = run[0]!;
            const last = run[run.length - 1]!;
            area += `M${sx(first.x).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)}`;
            for (const p of run) area += `L${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`;
            area += `L${sx(last.x).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)}Z`;
          }
          run = [];
        };
        for (const point of s.points) {
          if (point.y == null) flush();
          else run.push({ x: point.x, y: point.y });
        }
        flush();
      }

      return { line, area };
    });

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: PAD_TOP + plotH - f * plotH,
      label: formatY(ceiling * f),
    }));

    return { paths, ticks, minX, maxX, plotH, sx, sy, unsx, msPerPx: spanX / plotW };
  }, [series, height, maxY, formatY, VIEW_W]);

  /**
   * Every x the cursor may land on, deduplicated across series. Built from the
   * data rather than from pixels so the crosshair always sits on a sample.
   */
  const domain = useMemo(() => {
    const xs = new Set<number>();
    for (const s of series) for (const point of s.points) xs.add(point.x);
    return [...xs].sort((a, b) => a - b);
  }, [series]);

  const cursor = useMemo(() => {
    if (cursorX == null || !geometry) return null;

    const rows = series.flatMap((s, i) => {
      const points = s.points;
      if (points.length === 0) return [];

      const index = nearestIndex(points, cursorX);
      const point = points[index]!;
      // A series is sampled on its own schedule, so tolerate one and a half of
      // its own intervals — but never less than a pointer's worth of pixels.
      const spacing =
        points.length > 1
          ? (points[points.length - 1]!.x - points[0]!.x) / (points.length - 1)
          : 0;
      if (Math.abs(point.x - cursorX) > Math.max(spacing * 1.5, geometry.msPerPx * HIT_PX)) {
        return [];
      }

      return [
        {
          label: s.label,
          color: colorAt(series, i),
          text: point.y == null ? "—" : readout(point.y),
          py: point.y == null ? null : geometry.sy(point.y),
        },
      ];
    });

    if (rows.length === 0) return null;
    return { px: geometry.sx(cursorX), time: cursorX, rows };
  }, [cursorX, geometry, series, readout]);

  // Draw-on, replayed whenever the data set changes identity (range switch,
  // node switch) rather than on every value update.
  const signature = series.map((s) => `${s.label}:${s.points.length}`).join("|");
  useEffect(() => {
    const root = rootRef.current;
    if (!root || reducedMotion()) return;
    const lines = root.querySelectorAll<SVGPathElement>("[data-line]");
    if (lines.length === 0) return;

    const tween = gsap.fromTo(
      lines,
      { drawSVG: "0%" },
      { drawSVG: "100%", duration: 0.9, ease: "power2.out", stagger: 0.08 },
    );
    // A chart of unfilled series has no area paths at all; GSAP warns loudly
    // when handed an empty target list.
    const areas = root.querySelectorAll<SVGPathElement>("[data-area]");
    const fade = areas.length
      ? gsap.fromTo(areas, { opacity: 0 }, { opacity: 1, duration: 0.9, delay: 0.2 })
      : null;

    return () => {
      tween.kill();
      fade?.kill();
    };
  }, [signature]);

  // The host div is always rendered so the ResizeObserver has something to
  // measure on the very first paint.
  if (!geometry) {
    return <div ref={hostRef} className="observer-chart-host" style={{ height }} />;
  }

  const track = (clientX: number) => {
    const host = hostRef.current;
    if (!host || domain.length === 0) return;
    const rect = host.getBoundingClientRect();
    setByKeyboard(false);
    setCursorX(domain[snapIndex(domain, geometry.unsx(clientX - rect.left))]!);
  };

  const step = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (cursorX != null) setCursorX(null);
      return;
    }
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0 || domain.length === 0) return;
    // Arrow keys scroll the page by default, which would drag the chart out
    // from under the crosshair being aimed.
    event.preventDefault();
    // Entering from either end: the first press lands on the nearest edge.
    const from = cursorX == null ? (delta > 0 ? -1 : domain.length) : snapIndex(domain, cursorX);
    setByKeyboard(true);
    setCursorX(domain[Math.min(domain.length - 1, Math.max(0, from + delta))]!);
  };

  const span = geometry.maxX - geometry.minX;

  return (
    <div
      ref={hostRef}
      className="observer-chart-host"
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerMove={(e) => track(e.clientX)}
      onPointerDown={(e) => track(e.clientX)}
      onPointerLeave={() => setCursorX(null)}
      onPointerCancel={() => setCursorX(null)}
      onKeyDown={step}
      onBlur={() => setCursorX(null)}
    >
      <svg
        ref={rootRef}
        className="observer-chart"
        width={VIEW_W}
        height={height}
        viewBox={`0 0 ${VIEW_W} ${height}`}
        // The labelled group above is the accessible object; labelling the SVG
        // too would just announce the chart's name twice.
        aria-hidden="true"
      >
        {geometry.ticks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT}
              x2={VIEW_W - PAD_RIGHT}
              y1={tick.y}
              y2={tick.y}
              className="observer-chart-grid"
            />
            <text x={PAD_LEFT - 8} y={tick.y + 3} className="observer-chart-tick" textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}

        {geometry.paths.map((path, i) => {
          const color = colorAt(series, i);
          return (
            <g key={series[i]!.label}>
              {path.area && (
                <>
                  <defs>
                    <linearGradient id={`${id}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                      <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path data-area d={path.area} fill={`url(#${id}-g${i})`} stroke="none" />
                </>
              )}
              <path
                data-line
                d={path.line}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* Drawn last so the markers sit above every line. */}
        {cursor && (
          <g className="observer-chart-cursor" aria-hidden="true">
            <line x1={cursor.px} x2={cursor.px} y1={PAD_TOP} y2={PAD_TOP + geometry.plotH} />
            {cursor.rows.map((row, i) =>
              row.py == null ? null : (
                <circle
                  key={i}
                  className="observer-chart-dot"
                  cx={cursor.px}
                  cy={row.py}
                  r="3.5"
                  fill={row.color}
                />
              ),
            )}
          </g>
        )}
      </svg>

      {/*
        Always mounted, faded rather than unmounted: a live region has to exist
        before its content changes or the change is not announced. Kept outside
        the role="img" above, whose subtree is presentational to a screen reader.
      */}
      <div
        className="observer-chart-tip"
        data-open={cursor ? "true" : undefined}
        style={tipPosition(cursor?.px, VIEW_W)}
        role="status"
        aria-live={byKeyboard ? "polite" : "off"}
      >
        {cursor && (
          <>
            <div className="metric observer-chart-tip-time">{formatTime(cursor.time, span)}</div>
            {cursor.rows.map((row, i) => (
              <div key={i} className="observer-chart-tip-row">
                <span
                  className="observer-legend-swatch"
                  style={{ background: row.color }}
                  aria-hidden="true"
                />
                <span className="chrome observer-chart-tip-label">{row.label}</span>
                <span className="metric observer-chart-tip-value">{row.text}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const colorAt = (series: Series[], i: number) =>
  series[i]!.color ?? `var(--observer-chart-${(i % 9) + 1})`;

/** Flip the tooltip across the crosshair rather than let it leave the chart. */
function tipPosition(px: number | undefined, width: number): React.CSSProperties | undefined {
  if (px == null) return undefined;
  return px > width / 2 ? { right: `${width - px + 12}px` } : { left: `${px + 12}px` };
}

/**
 * Index of the sample nearest `x`. Linear: a series here is at most a few
 * hundred points after downsampling, and a binary search would be betting on an
 * ordering the caller never promised.
 */
function nearestIndex(points: ReadonlyArray<{ x: number }>, x: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < points.length; i++) {
    const delta = Math.abs(points[i]!.x - x);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/** Same, over the merged domain — which we sorted ourselves, so bisect it. */
function snapIndex(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  const below = Math.max(0, lo - 1);
  return x - sorted[below]! < sorted[lo]! - x ? below : lo;
}

/** Seconds only on short windows, a date once the window outgrows a day. */
function formatTime(x: number, spanMs: number): string {
  const date = new Date(x);
  const hours = spanMs / 3_600_000;
  if (hours > 24) {
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(hours <= 2 ? { second: "2-digit" } : {}),
  });
}
