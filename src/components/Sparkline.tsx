/**
 * A rolling sparkline fed by live ticks.
 *
 * Keeps its own ring buffer and repaints the path imperatively. No React state
 * is involved, so pushing a sample costs one string assignment.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";

export interface SparklineHandle {
  push(value: number): void;
  reset(): void;
}

interface SparklineProps {
  points?: number;
  width?: number;
  height?: number;
  /** Fixed upper bound. Omit to autoscale to the window's max. */
  max?: number;
  filled?: boolean;
  className?: string;
}

export const Sparkline = forwardRef<SparklineHandle, SparklineProps>(function Sparkline(
  { points = 40, width = 100, height = 24, max, filled = true, className },
  ref,
) {
  const lineRef = useRef<SVGPathElement | null>(null);
  const areaRef = useRef<SVGPathElement | null>(null);
  const buffer = useRef<number[]>([]);

  useImperativeHandle(ref, () => ({
    reset() {
      buffer.current = [];
      lineRef.current?.setAttribute("d", "");
      areaRef.current?.setAttribute("d", "");
    },
    push(value: number) {
      const buf = buffer.current;
      buf.push(Number.isFinite(value) ? value : 0);
      if (buf.length > points) buf.shift();
      if (buf.length < 2) return;

      // Autoscale keeps low-variance series legible; a hard floor of 1 avoids
      // dividing by zero and stops an all-zero series from filling the box.
      const ceiling = max ?? Math.max(1, ...buf);
      const stepX = width / (points - 1);
      // Right-align so a partially filled buffer grows leftward from "now".
      const offset = width - (buf.length - 1) * stepX;

      let d = "";
      for (let i = 0; i < buf.length; i++) {
        const x = offset + i * stepX;
        const y = height - (Math.min(buf[i]!, ceiling) / ceiling) * (height - 1) - 0.5;
        d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      lineRef.current?.setAttribute("d", d);

      if (filled && areaRef.current) {
        areaRef.current.setAttribute(
          "d",
          `${d}L${width} ${height}L${offset.toFixed(1)} ${height}Z`,
        );
      }
    },
  }));

  return (
    <svg
      className={`observer-spark ${className ?? ""}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {filled && <path ref={areaRef} className="observer-spark-area" d="" />}
      <path ref={lineRef} className="observer-spark-line" d="" />
    </svg>
  );
});
