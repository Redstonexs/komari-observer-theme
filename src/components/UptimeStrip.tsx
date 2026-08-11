/**
 * The availability strip: one block per time slot, over a real time axis.
 *
 * Presentational only — `buildUptime` in lib/uptime.ts decides what is up and
 * what is down, and NodeUptime owns the fetching. This file is what that
 * verdict looks like.
 *
 * A block's colour is a BLEND rather than one of two swatches: `--down` carries
 * the fraction of the block that was down, and the fill mixes green toward red
 * by that fraction. A block down for two minutes of thirty and a block down for
 * all thirty are not the same event and should not paint the same.
 *
 * The axis exists because a strip without one is unreadable: "the fourth red
 * block" is not an answer to "when was it down". Ticks land on round wall-clock
 * boundaries, and the readout under them gives the exact span of whichever
 * block is being pointed at.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UptimeSlot } from "@/lib/uptime";
import { formatClock, formatDay, formatDurationMs, formatStamp } from "@/lib/format";

interface UptimeStripProps {
  slots: UptimeSlot[];
  /** Left and right edge of the drawn window, epoch ms. */
  from: number;
  to: number;
  /**
   * No records for this range yet. The geometry is still real — the block count
   * belongs to the range that was just selected — but nothing is known about
   * any of it, so every block sits grey and the readout stays quiet.
   */
  pending: boolean;
  /** Measured strip width. Passed rather than read off the ref, because a ref
   *  mutation cannot re-run the tick layout. */
  width: number;
  /** Announced as the name of the whole strip. */
  label: string;
  /** The animation targets this element; see anim/gsap.ts. */
  stripRef: React.RefObject<HTMLDivElement | null>;
}

/** Tick spacings the axis may choose from. Every one divides a day evenly, so
 *  the labels land on hours a reader already thinks in. */
const AXIS_STEPS_MS = [1, 2, 3, 4, 6, 12, 24, 48].map((h) => h * 3_600_000);
/** Minimum room a tick label needs before the next one starts crowding it. */
const MIN_TICK_PX = 92;
/** A generated tick this close to the right edge would collide with "now". */
const EDGE_GUARD = 0.055;

export function UptimeStrip({
  slots,
  from,
  to,
  pending,
  width,
  label,
  stripRef,
}: UptimeStripProps) {
  const { t } = useTranslation();

  /** Block under the pointer, or reached with the arrow keys; null when idle. */
  const [cursor, setCursor] = useState<number | null>(null);
  /** Only announce the readout when it is being driven from the keyboard — a
   *  polite live region firing on every mouse sweep is noise. */
  const [byKeyboard, setByKeyboard] = useState(false);

  const span = Math.max(1, to - from);

  const ticks = useMemo(() => {
    if (width <= 0) return [];

    const maxTicks = Math.max(2, Math.floor(width / MIN_TICK_PX));
    const step =
      AXIS_STEPS_MS.find((ms) => span / ms <= maxTicks) ?? AXIS_STEPS_MS[AXIS_STEPS_MS.length - 1]!;

    return ticksFor(from, to, step)
      .map((time) => ({ time, at: (time - from) / span, step }))
      .filter((tick) => tick.at >= 0 && tick.at <= 1 - EDGE_GUARD);
  }, [from, to, span, width]);

  const active = cursor != null && !pending ? (slots[cursor] ?? null) : null;

  const move = (clientX: number) => {
    const strip = stripRef.current;
    if (!strip || pending || slots.length === 0) return;
    const rect = strip.getBoundingClientRect();
    const index = Math.floor(((clientX - rect.left) / rect.width) * slots.length);
    setByKeyboard(false);
    setCursor(Math.min(slots.length - 1, Math.max(0, index)));
  };

  const step = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (cursor != null) setCursor(null);
      return;
    }
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0 || pending || slots.length === 0) return;
    // Arrow keys scroll the page by default, which would drag the strip out
    // from under the block being aimed at.
    event.preventDefault();
    // Entering from either end: the first press lands on the nearest edge.
    const base = cursor == null ? (delta > 0 ? -1 : slots.length) : cursor;
    setByKeyboard(true);
    setCursor(Math.min(slots.length - 1, Math.max(0, base + delta)));
  };

  const stateLabel = (slot: UptimeSlot) => {
    if (slot.state === "unknown") return t("uptime.slotUnknown");
    if (slot.state === "online") return t("uptime.slotOnline");
    // Compared with slack rather than exactly: an outage covering a block end
    // to end lands a fraction of a millisecond under its own known time, and
    // "partly down" is plainly wrong for a block that renders solid red.
    return slot.downMs >= slot.knownMs * 0.995
      ? t("uptime.slotOffline")
      : t("uptime.slotPartial");
  };

  return (
    <div
      className="observer-uptime-body"
      role="group"
      aria-label={label}
      tabIndex={0}
      onKeyDown={step}
      onBlur={() => setCursor(null)}
    >
      <div
        className="observer-uptime-plot"
        onPointerMove={(e) => move(e.clientX)}
        onPointerDown={(e) => move(e.clientX)}
        onPointerLeave={() => setCursor(null)}
        onPointerCancel={() => setCursor(null)}
      >
        {/* Presentational: the group above is the accessible object, and the
            readout below is what actually gets announced. */}
        <div
          ref={stripRef}
          className="observer-uptime-strip observer-uptime-strip-lg"
          aria-hidden="true"
        >
          {/* `data-active` is gated on `active` rather than on `cursor`: a block
              count that shrank under the cursor — a narrower window, a shorter
              range — would leave an outline on a block nobody is pointing at. */}
          {slots.map((slot, i) => (
            <span
              key={i}
              className="observer-uptime-slot"
              data-slot={pending ? "pending" : slot.state}
              data-active={active !== null && cursor === i ? "true" : undefined}
              style={
                slot.knownMs > 0
                  ? ({ "--down": slot.downMs / slot.knownMs } as React.CSSProperties)
                  : undefined
              }
            />
          ))}
          <span className="observer-uptime-sweep" data-sweep aria-hidden="true" />
        </div>

        <div className="observer-uptime-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.time}
              className="observer-uptime-tick"
              style={{ left: `${tick.at * 100}%` }}
              data-edge={tick.at < EDGE_GUARD ? "start" : undefined}
            >
              <i />
              <em className="chrome">{tickLabel(tick.time, tick.step)}</em>
            </span>
          ))}
          {/* The window ends at the fetch, which is never a round hour — so it
              gets a label of its own rather than a time nobody asked about. */}
          <span className="observer-uptime-tick" style={{ left: "100%" }} data-edge="end">
            <i />
            <em className="chrome">{t("uptime.now")}</em>
          </span>
        </div>

        <div
          className="observer-uptime-tip"
          data-open={active ? "true" : undefined}
          style={tipPosition(cursor, slots.length)}
          role="status"
          aria-live={byKeyboard ? "polite" : "off"}
        >
          {active && (
            <>
              <div className="metric observer-uptime-tip-time">
                {formatStamp(active.from)} – {formatClock(active.to)}
              </div>
              <div className="observer-uptime-tip-row" data-slot={active.state}>
                <span className="status-dot" aria-hidden="true" />
                <span className="chrome observer-uptime-tip-state">{stateLabel(active)}</span>
                {/* Keyed to the state, not to `downMs`: a block that renders
                    solid green must never quote a downtime figure. */}
                {active.state === "down" && (
                  <span className="metric observer-uptime-tip-down">
                    {t("uptime.downFor", { duration: formatDurationMs(active.downMs) })}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="observer-uptime-legend chrome" aria-hidden="true">
        <span data-slot="online">{t("uptime.slotOnline")}</span>
        <span data-slot="down">{t("uptime.slotOffline")}</span>
        <span data-slot="unknown">{t("uptime.slotUnknown")}</span>
      </div>
    </div>
  );
}

/**
 * Tick times at `stepMs`, snapped to local wall-clock boundaries.
 *
 * Whole-day steps advance by calendar date rather than by 86.4M milliseconds,
 * so a daylight-saving change shifts the labels to 23:00 and 01:00 for the rest
 * of the week instead of keeping them on midnight.
 */
function ticksFor(from: number, to: number, stepMs: number): number[] {
  const out: number[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  // Whole days only. Rounding here would make a 12-hour step round up to one
  // day and silently drop every midday tick.
  const days = stepMs / 86_400_000;
  if (Number.isInteger(days) && days >= 1) {
    while (cursor.getTime() < from) cursor.setDate(cursor.getDate() + days);
    while (cursor.getTime() <= to) {
      out.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + days);
    }
    return out;
  }

  let time = cursor.getTime();
  while (time < from) time += stepMs;
  for (; time <= to; time += stepMs) out.push(time);
  return out;
}

/** A midnight on a multi-day axis is a date; everything else is a clock time. */
function tickLabel(time: number, stepMs: number): string {
  const date = new Date(time);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  return stepMs >= 12 * 3_600_000 && midnight ? formatDay(time) : formatClock(time);
}

/** Anchor the readout to the middle of its block, flipping at the halfway mark
 *  rather than letting it run off the panel. */
function tipPosition(cursor: number | null, count: number): React.CSSProperties | undefined {
  if (cursor == null || count === 0) return undefined;
  const at = (cursor + 0.5) / count;
  return at > 0.5 ? { right: `${(1 - at) * 100}%` } : { left: `${at * 100}%` };
}
