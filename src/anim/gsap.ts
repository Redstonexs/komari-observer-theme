/**
 * GSAP registration and the animation primitives this theme needs.
 *
 * Bundled under the GSAP Standard "No Charge" License (c) Webflow — see
 * THIRD-PARTY-NOTICES.md. Not MIT, and not sublicensable, which is why the
 * bundler is configured to preserve GSAP's /*! license banners.
 */

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Flip } from "gsap/Flip";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { useEffect, useRef } from "react";

// Explicit registration is mandatory — bundlers tree-shake unregistered
// plugins out, and the failure is silent at build time and only shows up as a
// runtime "Missing plugin?" warning.
gsap.registerPlugin(useGSAP, DrawSVGPlugin, Flip, ScrambleTextPlugin);

// A backgrounded tab produces huge frame gaps. Without lag smoothing GSAP would
// jump every animation forward on return; the default 500ms threshold is a bit
// eager for a dashboard people leave open all day.
gsap.ticker.lagSmoothing(1000, 16);

export { gsap, useGSAP, Flip, DrawSVGPlugin, ScrambleTextPlugin };

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * True when `target` actually resolves to something animatable.
 *
 * GSAP logs "GSAP target not found" for empty targets and then silently does
 * nothing. Since our targets come from selectors and live DOM queries that can
 * legitimately match nothing (a chart with no filled series, a card list that
 * has been filtered empty), every call site checks first rather than relying on
 * GSAP to no-op quietly.
 */
export function hasTarget(target: unknown): boolean {
  if (!target) return false;
  if (Array.isArray(target)) return target.length > 0;
  if (typeof (target as ArrayLike<unknown>).length === "number") {
    return (target as ArrayLike<unknown>).length > 0;
  }
  return true;
}

/**
 * Tweens a formatted number toward a target without re-rendering React.
 *
 * The idiomatic `gsap.to(el, {innerText: n, snap: ...})` allocates and reparses
 * text every frame. quickTo instead reuses ONE tween on a proxy object and we
 * write the formatted string ourselves — which matters when 100+ cards each
 * update several values every 2 seconds.
 */
export function useCountTo(
  format: (value: number) => string,
  options?: { duration?: number; initial?: number },
) {
  const ref = useRef<HTMLElement | null>(null);
  const proxy = useRef({ value: options?.initial ?? 0 });
  const setter = useRef<((value: number) => void) | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (reducedMotion()) {
      // No tween at all: write straight through.
      setter.current = (value: number) => {
        proxy.current.value = value;
        el.textContent = format(value);
      };
      el.textContent = format(proxy.current.value);
      return () => {
        setter.current = null;
      };
    }

    const quick = gsap.quickTo(proxy.current, "value", {
      duration: options?.duration ?? 0.55,
      ease: "power2.out",
      onUpdate: () => {
        el.textContent = format(proxy.current.value);
      },
    });
    setter.current = (value: number) => quick(value);
    el.textContent = format(proxy.current.value);

    return () => {
      // Kill the tween explicitly — quickTo's tween is not owned by any
      // gsap.context, so an unmounted card would otherwise keep it alive.
      quick.tween?.kill();
      setter.current = null;
    };
    // `format` is expected to be stable (module-level or useCallback).
  }, [format, options?.duration]);

  const set = (value: number) => setter.current?.(value);
  return { ref, set };
}

/** Brief accent flash when a value changes materially. */
export function pulse(el: Element | null | undefined, enabled = true) {
  if (!el || !enabled || reducedMotion()) return;
  gsap.fromTo(
    el,
    { "--pulse": 1 },
    {
      "--pulse": 0,
      duration: 0.9,
      ease: "power2.out",
      // Default overwrite:false leaves two pulses fighting over the same
      // property when data changes faster than the animation runs.
      overwrite: "auto",
    },
  );
}

/**
 * The boot sequence. Returns a timeline so the caller can await or reverse it.
 * Collapses to an instant reveal under reduced motion.
 */
export function bootTimeline(scope: HTMLElement): gsap.core.Timeline {
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  const q = gsap.utils.selector(scope);

  const all = q("[data-boot]");
  if (reducedMotion()) {
    if (hasTarget(all)) tl.set(all, { opacity: 1, y: 0 });
    return tl;
  }

  const rule = q("[data-boot='rule']");
  const brand = q("[data-boot='brand']");
  const chrome = q("[data-boot='chrome']");

  tl.addLabel("intro");
  if (hasTarget(rule)) {
    tl.fromTo(rule, { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.7 });
  }
  if (hasTarget(brand)) {
    tl.fromTo(brand, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, "-=0.45");
  }
  if (hasTarget(chrome)) {
    tl.fromTo(
      chrome,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, stagger: 0.05 },
      "-=0.3",
    );
  }
  tl.addLabel("ready");

  return tl;
}

/**
 * Staggered card entrance. `grid: "auto"` + `from: "center"` reads as the
 * fleet resolving into focus rather than a list sliding in.
 */
export function revealCards(targets: gsap.DOMTarget) {
  const elements = gsap.utils.toArray<HTMLElement>(targets);
  if (elements.length === 0) return;

  if (reducedMotion()) {
    gsap.set(elements, { opacity: 1, y: 0, scale: 1 });
    return;
  }

  gsap.fromTo(
    elements,
    { opacity: 0, y: 14, scale: 0.985 },
    {
      opacity: 1,
      y: 0,
      scale: 1,
      duration: 0.5,
      ease: "power2.out",
      stagger: { amount: Math.min(0.5, elements.length * 0.02), grid: "auto", from: "center" },
      // force3D promotes to a compositor layer for the tween then drops back;
      // GSAP never sets will-change itself.
      force3D: true,
    },
  );
}

/** How long the availability sweep takes to cross the strip, in seconds. */
const SWEEP_SPAN = 0.55;

/**
 * Drops every block of an availability strip back to its resting grey.
 *
 * Run the instant the selected range changes, before the new records land. The
 * strip on screen describes the OLD window at the OLD block width, and leaving
 * it up while the next window loads is exactly how a range switch used to flash
 * downtime that never happened.
 */
export function fadeToPending(strip: HTMLElement | null): void {
  if (!strip) return;
  const slots = strip.querySelectorAll<HTMLElement>("[data-slot]");
  if (!hasTarget(slots)) return;

  if (reducedMotion()) {
    // clearProps rather than scaleY: 1 — nothing scaled these, and writing an
    // identity transform would pin every block to a compositor layer for good.
    gsap.set(slots, { "--reveal": 0, clearProps: "transform" });
    return;
  }
  gsap.to(slots, {
    "--reveal": 0,
    scaleY: 1,
    duration: 0.2,
    ease: "power1.out",
    stagger: { amount: 0.12, from: "start" },
    // A range switched twice in quick succession leaves two tweens fighting
    // over the same property otherwise.
    overwrite: "auto",
  });
}

/**
 * Resolves a grey strip into its colours, left to right, behind a scanline.
 *
 * The stagger uses `amount` rather than `each` so the sweep takes the same time
 * whether the strip carries 24 blocks or 90 — with `each`, a wide window would
 * crawl while a narrow one snapped.
 */
export function sweepReveal(
  strip: HTMLElement | null,
  options?: { delay?: number; onStart?: () => void },
): gsap.core.Timeline | null {
  if (!strip) return null;
  const slots = strip.querySelectorAll<HTMLElement>("[data-slot]");
  if (!hasTarget(slots)) return null;

  const scan = strip.querySelector<HTMLElement>("[data-sweep]");

  if (reducedMotion()) {
    gsap.set(slots, { "--reveal": 1, clearProps: "transform" });
    if (scan) gsap.set(scan, { opacity: 0 });
    options?.onStart?.();
    return null;
  }

  const tl = gsap.timeline({ delay: options?.delay ?? 0, onStart: options?.onStart });

  tl.fromTo(
    slots,
    { "--reveal": 0, scaleY: 0.5 },
    {
      "--reveal": 1,
      scaleY: 1,
      duration: 0.4,
      ease: "power2.out",
      stagger: { amount: SWEEP_SPAN, from: "start" },
      force3D: true,
      // The resting CSS already says scaleY(1); leaving GSAP's inline transform
      // behind would pin every block to a compositor layer for good.
      clearProps: "transform",
    },
    0,
  );

  if (scan) {
    // Travelled as a transform over the measured width rather than as `left`,
    // which would relayout the whole strip on every frame of the sweep.
    tl.fromTo(scan, { x: 0, opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, 0)
      .to(scan, { x: strip.clientWidth, duration: SWEEP_SPAN, ease: "none" }, 0)
      .to(scan, { opacity: 0, duration: 0.16, ease: "none" }, SWEEP_SPAN - 0.06);
  }

  return tl;
}

/** Decode-in effect for hostnames. Purely decorative, so it degrades to a no-op. */
export function scrambleIn(el: Element | null | undefined, text: string, enabled: boolean) {
  if (!el) return;
  if (!enabled || reducedMotion()) {
    el.textContent = text;
    return;
  }
  gsap.to(el, {
    duration: 0.8,
    scrambleText: { text, chars: "01", speed: 0.4, revealDelay: 0.15 },
    ease: "none",
  });
}
