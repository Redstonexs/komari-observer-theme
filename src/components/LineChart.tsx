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
  ariaLabel?: string;
}

const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

export function LineChart({
  series,
  height = 200,
  maxY,
  formatY = (v) => String(Math.round(v)),
  ariaLabel,
}: LineChartProps) {
  const id = useId().replace(/:/g, "");
  const rootRef = useRef<SVGSVGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

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

    return { paths, ticks, minX, maxX, plotH };
  }, [series, height, maxY, formatY, VIEW_W]);

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

  return (
    <div ref={hostRef} className="observer-chart-host">
      <svg
        ref={rootRef}
        className="observer-chart"
        width={VIEW_W}
        height={height}
        viewBox={`0 0 ${VIEW_W} ${height}`}
        role="img"
        aria-label={ariaLabel}
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
        const color = series[i]!.color ?? `var(--observer-chart-${(i % 9) + 1})`;
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
      </svg>
    </div>
  );
}
