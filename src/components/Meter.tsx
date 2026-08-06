/**
 * Linear usage meter — the flat counterpart to the radial Gauge.
 *
 * Same contract as the gauge: an imperative `set()` so a live tick can move the
 * bar without a React render, and the same shared thresholds so a card showing
 * one metric on two instruments never disagrees with itself.
 *
 * Colour is the status ramp (green / amber / red) rather than the accent the
 * gauge sweeps in. The two answer different questions — the dial reports a
 * number, the bar reports whether that number is fine — and that is the same
 * division the theme already draws between an accent-coloured gauge and the
 * green status dot sitting above it on the same card.
 *
 * The fill is TRANSFORMED, never resized. A fleet view holds several hundred of
 * these; scaleX composites, where tweening width would relayout every one of
 * them on every frame.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { gsap, reducedMotion } from "@/anim/gsap";
import { USAGE_BAD, USAGE_WARN, usageLevel } from "@/lib/levels";

export interface MeterHandle {
  /** `percent` is 0-100. */
  set(percent: number): void;
}

interface MeterProps {
  /** Accessible name — the metric this bar measures. */
  label: string;
  /** Percent above which the fill turns warn / bad. */
  warnAt?: number;
  badAt?: number;
  className?: string;
}

export const Meter = forwardRef<MeterHandle, MeterProps>(function Meter(
  { label, warnAt = USAGE_WARN, badAt = USAGE_BAD, className },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const writeRef = useRef<((percent: number) => void) | null>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);

  // quickTo's tween is owned by no gsap.context, so a card scrolled out of the
  // fleet would otherwise leave it on the global ticker for the session.
  useEffect(
    () => () => {
      tweenRef.current?.kill();
      tweenRef.current = null;
      writeRef.current = null;
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    set(percent: number) {
      const root = rootRef.current;
      const fill = fillRef.current;
      if (!root || !fill) return;

      const clamped = Math.max(0, Math.min(100, percent));

      // Mirrored to a data attribute rather than written as a style, so the
      // level can also drive things the bar does not own.
      const level = usageLevel(clamped, warnAt, badAt);
      if (root.dataset.level !== level) root.dataset.level = level;

      // ARIA is written once per tick from the TARGET value, never from the
      // tween's onUpdate: rewriting an attribute 60 times a second across a few
      // hundred bars rebuilds the accessibility tree continuously and adds
      // nothing a reader could act on.
      const now = String(Math.round(clamped));
      if (root.getAttribute("aria-valuenow") !== now) {
        root.setAttribute("aria-valuenow", now);
        root.setAttribute("aria-valuetext", `${now}%`);
      }

      if (!writeRef.current) {
        if (reducedMotion()) {
          writeRef.current = (value) => {
            gsap.set(fill, { scaleX: value / 100 });
          };
        } else {
          // One reused tween rather than a new one per tick.
          const quick = gsap.quickTo(fill, "scaleX", { duration: 0.5, ease: "power2.out" });
          tweenRef.current = quick.tween;
          writeRef.current = (value) => {
            quick(value / 100);
          };
        }
      }

      writeRef.current(clamped);
    },
  }));

  return (
    <div
      ref={rootRef}
      className={className ? `observer-meter ${className}` : "observer-meter"}
      data-level="ok"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      aria-valuetext="0%"
    >
      <span ref={fillRef} className="observer-meter-fill" />
    </div>
  );
});
