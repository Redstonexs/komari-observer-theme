/**
 * Radial arc gauge.
 *
 * Uses DrawSVGPlugin on a <circle>, which the plugin supports even though the
 * docs only list paths — that saves computing stroke-dasharray by hand and
 * keeps the sweep animation exact at any radius.
 *
 * Exposes an imperative `set()` so a live tick can move the arc without a
 * React render.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";
import { gsap, reducedMotion } from "@/anim/gsap";

export interface GaugeHandle {
  /** `percent` is 0-100. */
  set(percent: number): void;
}

interface GaugeProps {
  label: string;
  size?: number;
  /** Percent above which the arc turns warn / bad. */
  warnAt?: number;
  badAt?: number;
  /** Rendered under the arc; defaults to the numeric percent. */
  unit?: string;
}

const SWEEP = 0.75; // three-quarter arc, gap at the bottom

export const Gauge = forwardRef<GaugeHandle, GaugeProps>(function Gauge(
  { label, size = 74, warnAt = 75, badAt = 90, unit = "%" },
  ref,
) {
  const arcRef = useRef<SVGCircleElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const quickRef = useRef<((value: number) => void) | null>(null);
  const proxy = useRef({ v: 0 });

  const radius = (size - 10) / 2;
  const cx = size / 2;

  useImperativeHandle(ref, () => ({
    set(percent: number) {
      const clamped = Math.max(0, Math.min(100, percent));

      // Threshold state drives colour AND is mirrored to a data attribute so
      // the label can carry a non-colour cue too.
      const state = clamped >= badAt ? "bad" : clamped >= warnAt ? "warn" : "ok";
      if (rootRef.current && rootRef.current.dataset.level !== state) {
        rootRef.current.dataset.level = state;
      }

      if (!quickRef.current && arcRef.current) {
        const arc = arcRef.current;
        const text = valueRef.current;
        // Written directly rather than through a CSS custom property: SVG
        // stroke-dasharray with calc(var(...)) is inconsistently supported,
        // and this is one string assignment per tick either way.
        const write = () => {
          const v = proxy.current.v;
          const drawn = circumference * SWEEP * (v / 100);
          arc.style.strokeDasharray = `${drawn} ${circumference}`;
          if (text) text.textContent = v.toFixed(v >= 100 ? 0 : 1);
        };

        if (reducedMotion()) {
          quickRef.current = (value: number) => {
            proxy.current.v = value;
            write();
          };
        } else {
          // One reused tween rather than a new one per tick.
          const quick = gsap.quickTo(proxy.current, "v", {
            duration: 0.5,
            ease: "power2.out",
            onUpdate: write,
          });
          quickRef.current = (value: number) => quick(value);
        }
      }

      quickRef.current?.(clamped);
    },
  }));

  const circumference = 2 * Math.PI * radius;

  return (
    <div ref={rootRef} className="observer-gauge" data-level="ok" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(135 ${cx} ${cx})`}>
          <circle
            cx={cx}
            cy={cx}
            r={radius}
            className="observer-gauge-track"
            strokeDasharray={`${circumference * SWEEP} ${circumference}`}
          />
          <circle
            ref={arcRef}
            cx={cx}
            cy={cx}
            r={radius}
            className="observer-gauge-arc"
            strokeDasharray={`0 ${circumference}`}
          />
        </g>
      </svg>
      <div className="observer-gauge-center">
        <span ref={valueRef} className="metric observer-gauge-value">
          0.0
        </span>
        <span className="observer-gauge-unit">{unit}</span>
      </div>
      <div className="chrome observer-gauge-label">{label}</div>
    </div>
  );
});
