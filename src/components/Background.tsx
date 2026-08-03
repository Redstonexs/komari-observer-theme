/**
 * Drives the background layers declared in index.html.
 *
 * Those layers live outside #root on purpose: remounting them on a route
 * change would restart a video decoder or re-fetch a multi-megabyte image.
 * This component only mutates them — it renders nothing.
 */

import { useEffect } from "react";
import { gsap, hasTarget } from "@/anim/gsap";
import { useAppStore } from "@/store/app";
import type { BackgroundMode } from "@/config/settings";

/** Video is heavy; skip it where it would hurt most. */
function videoAllowed(): boolean {
  if (window.matchMedia("(max-width: 768px)").matches) return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Background() {
  const settings = useAppStore((s) => s.settings);
  const dark = useAppStore((s) => s.resolvedDark);
  const override = useAppStore((s) => s.backgroundOverride);

  // A visitor override may name a built-in mode or supply an image URL.
  const allowOverride = settings.allow_visitor_background;
  const effective: { mode: BackgroundMode; image: string } = (() => {
    if (allowOverride && override) {
      if (/^https?:\/\//i.test(override)) return { mode: "image", image: override };
      const known: BackgroundMode[] = ["none", "aurora", "starfield", "grid"];
      if ((known as string[]).includes(override)) {
        return { mode: override as BackgroundMode, image: "" };
      }
    }
    const image = dark
      ? settings.bg_image_dark || settings.bg_image_light
      : settings.bg_image_light || settings.bg_image_dark;
    return { mode: settings.bg_mode, image };
  })();

  /* ---- Compositing variables ------------------------------------- */
  useEffect(() => {
    const root = document.documentElement;
    const overlay = settings.bg_overlay;

    // One signed control, two effects: positive lays a scrim over the media,
    // negative fades the media itself toward the page colour.
    root.style.setProperty("--observer-bg-scrim", String(overlay > 0 ? overlay / 100 : 0));
    root.style.setProperty("--observer-bg-fade", String(overlay < 0 ? 1 + overlay / 100 : 1));
    root.style.setProperty("--observer-bg-blur", `${settings.bg_blur}px`);

    root.dataset.grid = settings.enable_grid_overlay ? "on" : "off";
    root.dataset.glow = settings.enable_glow ? "on" : "off";
    root.dataset.density = settings.density;
    root.dataset.accent = settings.accent;

    const bg = document.getElementById("observer-bg");
    if (bg) bg.style.position = settings.bg_fixed ? "fixed" : "absolute";
  }, [
    settings.bg_overlay,
    settings.bg_blur,
    settings.bg_fixed,
    settings.enable_grid_overlay,
    settings.enable_glow,
    settings.density,
    settings.accent,
  ]);

  /* ---- Media layer (image / video) -------------------------------- */
  useEffect(() => {
    const host = document.getElementById("observer-bg-media");
    if (!host) return;

    const clear = () => {
      // Explicit teardown, not innerHTML: a <video> keeps its decoder and
      // network connection alive until told otherwise.
      host.querySelectorAll("video").forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        v.load();
      });
      host.replaceChildren();
    };

    if (effective.mode === "image" && effective.image) {
      let cancelled = false;
      // Preload detached so a slow or broken image never shows a half-painted
      // layer; only swap in on a confirmed load.
      const probe = new Image();
      probe.decoding = "async";
      probe.src = effective.image;
      probe.onload = () => {
        if (cancelled) return;
        clear();
        const img = document.createElement("img");
        img.src = effective.image;
        img.alt = "";
        img.decoding = "async";
        host.appendChild(img);
        if (hasTarget(host)) {
          gsap.fromTo(host, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "power2.out" });
        }
      };
      probe.onerror = () => {
        if (!cancelled) clear();
      };
      return () => {
        cancelled = true;
        probe.onload = probe.onerror = null;
      };
    }

    if (effective.mode === "video" && settings.bg_video && videoAllowed()) {
      clear();
      const video = document.createElement("video");
      video.src = settings.bg_video;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      host.appendChild(video);
      // Autoplay can still be refused; failing silently is correct here.
      void video.play().catch(() => {});
      return clear;
    }

    clear();
    return undefined;
  }, [effective.mode, effective.image, settings.bg_video]);

  /* ---- Canvas layer (aurora / starfield) -------------------------- */
  useEffect(() => {
    const canvas = document.getElementById("observer-bg-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;

    const wantsCanvas = effective.mode === "aurora" || effective.mode === "starfield";
    const ctx = wantsCanvas ? canvas.getContext("2d") : null;

    if (!wantsCanvas || !ctx) {
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "block";

    const still = prefersReducedMotion();
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      // Cap DPR at 2: beyond that a full-viewport canvas costs a lot of fill
      // rate for a decorative layer nobody looks directly at.
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--observer-accent")
      .trim();

    const stars = Array.from({ length: 140 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random() * 0.8 + 0.2,
      twinkle: Math.random() * Math.PI * 2,
    }));

    let elapsed = 0;

    const drawStarfield = () => {
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        const x = s.x * width;
        // Slow vertical drift; wraps rather than resetting so there is no seam.
        const y = ((s.y + elapsed * 0.004 * s.z) % 1) * height;
        const alpha = (0.25 + 0.55 * s.z) * (0.6 + 0.4 * Math.sin(s.twinkle + elapsed * 1.4));
        ctx.globalAlpha = Math.max(0, alpha) * 0.5;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(x, y, s.z * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawAurora = () => {
      ctx.clearRect(0, 0, width, height);
      // Three offset radial washes; the slow phase offsets keep them from ever
      // lining up into an obvious repeating pattern.
      for (let i = 0; i < 3; i++) {
        const phase = elapsed * 0.09 + i * 2.2;
        const cx = width * (0.5 + 0.34 * Math.sin(phase * 0.7 + i));
        const cy = height * (0.28 + 0.22 * Math.cos(phase * 0.5 + i * 1.4));
        const radius = Math.max(width, height) * (0.42 + 0.1 * Math.sin(phase));
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, accent);
        grad.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.globalAlpha = 1;
    };

    const draw = effective.mode === "starfield" ? drawStarfield : drawAurora;
    draw();

    if (still) {
      // Reduced motion: paint one static frame and never start a loop.
      return () => window.removeEventListener("resize", resize);
    }

    const tick = (_time: number, delta: number) => {
      // A hidden tab still gets occasional ticks; skipping the draw keeps a
      // backgrounded dashboard from burning battery.
      if (document.hidden) return;
      elapsed += delta / 1000;
      draw();
    };

    // 30fps is plenty for a diffuse background and halves the fill cost.
    gsap.ticker.fps(30);
    gsap.ticker.add(tick);

    return () => {
      window.removeEventListener("resize", resize);
      // Critical: GSAP only powers down its rAF loop when it has fewer than 2
      // ticker listeners. Leaving this attached would keep an idle dashboard
      // spinning a rAF forever.
      gsap.ticker.remove(tick);
      gsap.ticker.fps(60);
      ctx.clearRect(0, 0, width, height);
    };
  }, [effective.mode]);

  return null;
}
