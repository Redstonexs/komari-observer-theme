/**
 * Per-node latency and availability.
 *
 * Both metrics belong to a node, not to the fleet: a "fleet latency" is not a
 * meaningful number, and a fleet-wide availability percentage hides exactly the
 * one node that was down. So they are rendered here, scoped to a single uuid,
 * and the dashboard-level pages exist only as per-node comparisons.
 *
 * Availability is DERIVED, not measured. Komari keeps no uptime history —
 * `uptime` is commented out of models.Record — so downtime is inferred from
 * the gaps between load records; see lib/uptime.ts for why it is read off gaps
 * rather than off block occupancy. That inference is stated in the UI rather
 * than presented as fact.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLoadRecords, getPingRecords, getPingTasks } from "@/api/client";
import type { LoadRecord, PingRecord, PublicPingTask } from "@/api/types";
import { LineChart, type Series } from "@/components/LineChart";
import { UptimeStrip } from "@/components/UptimeStrip";
import { LOSS_THRESHOLDS } from "@/config/settings";
import { useAppStore } from "@/store/app";
import { formatDurationMs, formatLatency } from "@/lib/format";
import { downsample } from "@/lib/series";
import { buildUptime } from "@/lib/uptime";
import { fadeToPending, sweepReveal, useCountTo } from "@/anim/gsap";

/** Each block owns its own window, so neither control can surprise the other. */
const PING_RANGES = [4, 12, 24, 72] as const;
const UPTIME_RANGES = [24, 72, 168] as const;

/** Slot width the availability strip aims for, gap included. */
const SLOT_PITCH_PX = 28;
/**
 * Block widths the strip may pick from, in minutes.
 *
 * Purely a density choice now: gap-based inference does not care whether a
 * block is wider than the server's sampling interval, so this ladder answers
 * "how many blocks fit" and nothing else. Round numbers only — a reader can
 * reason about "3h", and nothing is gained by offering them "3h 37m".
 */
const SLOT_MINUTES = [10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 720] as const;
/**
 * How long the strip stays grey before it starts resolving.
 *
 * A cached response can land in a few milliseconds, and a reveal that begins
 * before the grey has been seen reads as a glitch rather than as a refresh.
 */
const PENDING_DWELL_MS = 180;

/** `formatLatency` returns an em dash for "no sample" — don't suffix that. */
const latency = (ms: number) => (ms >= 0 ? `${formatLatency(ms)}ms` : "—");

/* ================================================================== *
 * Latency
 * ================================================================== */

export function NodeLatency({ uuid }: { uuid: string }) {
  const { t } = useTranslation();
  const sensitivity = useAppStore((s) => s.settings.loss_sensitivity);

  const [hours, setHours] = useState<number>(12);
  const [tasks, setTasks] = useState<PublicPingTask[]>([]);
  const [records, setRecords] = useState<PingRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getPingTasks()
      .then((list) => {
        if (cancelled) return;
        // Only probes that actually cover this node.
        setTasks(list.filter((task) => task.clients?.includes(uuid)));
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // uuid alone is a valid query — the server returns every task for it.
    getPingRecords({ uuid, hours })
      .then((data) => {
        if (!cancelled) setRecords(data.records ?? []);
      })
      .catch(() => {
        // A hidden node returns 200 with an empty body rather than an error,
        // so a rejection here just means nothing to show.
        if (!cancelled) setRecords([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid, hours]);

  const taskName = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.name])),
    [tasks],
  );

  const { series, stats } = useMemo(() => {
    const byTask = new Map<number, PingRecord[]>();
    for (const record of records) {
      const list = byTask.get(record.task_id);
      if (list) list.push(record);
      else byTask.set(record.task_id, [record]);
    }

    const out: Series[] = [];
    const summary: Array<{
      id: number;
      name: string;
      /** Position in `out` — the legend swatch has to track the LINE's colour,
       *  and the summary is sorted by name afterwards. */
      slot: number;
      loss: number;
      avg: number;
      min: number;
      max: number;
    }> = [];

    for (const [id, list] of byTask) {
      list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      // A NEGATIVE value is packet loss, not a latency. Mapping it to null
      // produces a real gap instead of a line dropping to the floor.
      const points = list.map((r) => ({
        x: Date.parse(r.time),
        y: r.value < 0 ? null : r.value,
      }));
      const good = list.filter((r) => r.value >= 0).map((r) => r.value);
      const lost = list.length - good.length;

      const name = taskName.get(id) ?? `#${id}`;
      const slot = out.length;
      // Loss statistics below are computed from the FULL record set — only the
      // drawn line is reduced.
      out.push({ label: name, points: downsample(points), filled: false });
      summary.push({
        id,
        name,
        slot,
        loss: list.length ? (lost / list.length) * 100 : 0,
        avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : -1,
        min: good.length ? Math.min(...good) : -1,
        max: good.length ? Math.max(...good) : -1,
      });
    }

    summary.sort((a, b) => a.name.localeCompare(b.name));
    return { series: out, stats: summary };
  }, [records, taskName]);

  const thresholds = LOSS_THRESHOLDS[sensitivity];

  if (!loading && series.length === 0) return null;

  return (
    <div className="observer-chartblock panel">
      <div className="observer-history-head">
        <h3 className="chrome">{t("ping.title")}</h3>
        <div className="observer-segmented">
          {PING_RANGES.map((h) => (
            <button key={h} type="button" data-active={hours === h} onClick={() => setHours(h)}>
              {h >= 24 ? t("detail.days", { count: h / 24 }) : t("detail.hours", { count: h })}
            </button>
          ))}
        </div>
      </div>
      {loading && series.length === 0 ? (
        <p className="observer-empty chrome">…</p>
      ) : (
        <>
          <LineChart
            series={series}
            height={200}
            formatY={(v) => `${Math.round(v)}ms`}
            // The axis rounds; a value being pointed at should not, or a probe
            // sitting at 17.4ms and one at 16.6ms read as the same number.
            formatValue={(v) => `${formatLatency(v)}ms`}
            ariaLabel={t("ping.title")}
          />
          <div className="observer-pingstats">
            {stats.map((row) => {
              const level =
                row.loss >= thresholds.bad
                  ? "bad"
                  : row.loss >= thresholds.warn
                    ? "warn"
                    : "online";
              return (
                <div key={row.id} className="observer-pingstat" data-status={level}>
                  <span
                    className="observer-legend-swatch"
                    style={{ background: `var(--observer-chart-${(row.slot % 9) + 1})` }}
                    aria-hidden="true"
                  />
                  <span className="chrome observer-pingstat-name">{row.name}</span>
                  {/* Loss carries a dot AND a number, so status is never colour-only. */}
                  <span className="status-dot" aria-hidden="true" />
                  <span className="metric">
                    {row.loss.toFixed(1)}% {t("ping.loss")}
                  </span>
                  <span className="metric observer-pingstat-avg">
                    {latency(row.avg)} {t("ping.avg")}
                  </span>
                  <span className="metric observer-pingstat-range">
                    {latency(row.min)} / {latency(row.max)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="chrome observer-note">{t("ping.lossNote")}</p>
        </>
      )}
    </div>
  );
}

/* ================================================================== *
 * Availability
 * ================================================================== */

interface Snapshot {
  records: LoadRecord[];
  /** The fetch time travels with the records: the window is anchored to it, so
   *  a resize re-slices the same data instead of sliding out from under it. */
  fetchedAt: number;
  /** ...and so does the range that was asked for. See `snapshot` below. */
  hours: number;
}

export function NodeUptime({ uuid }: { uuid: string }) {
  const { t } = useTranslation();
  const recordEnabled = useAppStore((s) => s.publicSettings?.record_enabled ?? true);
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<Snapshot | null>(null);
  // Which request failed, not merely that one did: clearing a boolean from the
  // fetch effect would paint one frame of "no history" over the range the user
  // just picked, because effects run after the browser has already painted.
  const [failedFor, setFailedFor] = useState<string | null>(null);

  // The strip spans the page, so a fixed block count cannot serve every width:
  // the 24 that read well in a half-width panel stretch into bars across a
  // desktop, and blocks fine enough for a desktop become confetti on a phone.
  // Measured the way LineChart measures its host.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
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

  const slotMs = useMemo(() => {
    const ideal = (hours * 60) / Math.max(8, Math.round(width / SLOT_PITCH_PX));
    const minutes = SLOT_MINUTES.reduce((best, m) =>
      Math.abs(m - ideal) < Math.abs(best - ideal) ? m : best,
    );
    return minutes * 60_000;
  }, [hours, width]);

  useEffect(() => {
    if (!recordEnabled) return;
    const controller = new AbortController();
    getLoadRecords(uuid, hours, "cpu", { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) {
          setData({ records: res.records ?? [], fetchedAt: Date.now(), hours });
        }
      })
      .catch(() => {
        // An abort is this component replacing its own request, not a failure.
        if (!controller.signal.aborted) setFailedFor(`${uuid}|${hours}`);
      });
    // Ranges clicked in quick succession would otherwise race each other, and
    // the loser would still have cost the server a full window of records.
    return () => controller.abort();
  }, [uuid, hours, recordEnabled]);

  /**
   * Records may only ever be read at the range they were fetched for.
   *
   * This is the fix for the range-switch flash. The server's cadence is a
   * function of the window — a day comes back every few minutes, a week comes
   * back hourly — so hourly records sliced into the 30-minute blocks of a
   * 1-day view left every second block empty and reported 50% availability
   * for a node that had never missed a beat.
   */
  const snapshot = data !== null && data.hours === hours ? data : null;
  const failed = failedFor === `${uuid}|${hours}`;
  const pending = snapshot === null && !failed;

  const uptime = useMemo(
    () =>
      buildUptime({
        // No snapshot yet: the geometry is still built for the range that was
        // just picked, so the strip greys out at its new block count and the
        // axis is already correct when the colour arrives.
        times: snapshot ? snapshot.records.map((r) => Date.parse(r.time)) : [],
        endsAt: snapshot ? snapshot.fetchedAt : Date.now(),
        spanMs: hours * 3_600_000,
        slotMs,
      }),
    [snapshot, hours, slotMs],
  );

  // Written straight to the DOM rather than through React: the readout tweens
  // alongside the sweep, and re-rendering the panel 60 times a second to move
  // one number would be absurd.
  const showDash = useRef(true);
  const formatAvailability = useCallback(
    (value: number) => (showDash.current ? "—" : `${value.toFixed(2)}%`),
    [],
  );
  const pct = useCountTo(formatAvailability, { duration: 0.6 });
  const setPct = pct.set;

  const greyedAt = useRef(0);
  useEffect(() => {
    if (!pending) return;
    greyedAt.current = Date.now();
    showDash.current = true;
    // Runs the readout down to zero behind the dash, so the count-up that
    // follows starts from nothing rather than from the old range's figure.
    setPct(0);
    fadeToPending(stripRef.current);
    // Deliberately keyed on `pending` alone. `setPct` is a fresh closure over a
    // stable ref on every render, so listing it would re-grey the strip on every
    // unrelated re-render.
  }, [pending]);

  // Replayed when the data set changes identity — a range switch, a node
  // switch, a refetch — but NOT when a resize re-slices the records in hand.
  const revealKey = snapshot ? `${uuid}|${hours}|${snapshot.fetchedAt}` : null;
  useEffect(() => {
    if (revealKey === null) return;
    const timeline = sweepReveal(stripRef.current, {
      delay: Math.max(0, PENDING_DWELL_MS - (Date.now() - greyedAt.current)) / 1000,
      onStart: () => {
        // A window with too little data to measure has no percentage to show,
        // and 0.00% would be a claim rather than an absence.
        showDash.current = uptime.availability < 0;
        setPct(Math.max(0, uptime.availability));
      },
    });
    return () => {
      timeline?.kill();
    };
    // Keyed on the identity string alone: `uptime` is rebuilt on every resize,
    // and depending on it would replay the sweep as the window is dragged.
  }, [revealKey]);

  if (!recordEnabled) return null;

  const empty = failed || (snapshot !== null && snapshot.records.length === 0);

  return (
    <div className="observer-chartblock panel">
      <div className="observer-history-head">
        <h3 className="chrome">{t("uptime.title")}</h3>
        <div className="observer-uptime-head-right">
          <span
            ref={pct.ref as React.RefObject<HTMLSpanElement | null>}
            className="metric observer-uptime-pct"
            data-pending={pending ? "true" : undefined}
          />
          <div className="observer-segmented">
            {UPTIME_RANGES.map((h) => (
              <button key={h} type="button" data-active={hours === h} onClick={() => setHours(h)}>
                {t("detail.days", { count: h / 24 })}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Always rendered, empty or not: it is what the ResizeObserver watches,
          and the block count is decided from its width. */}
      <div ref={hostRef} className="observer-uptime-host">
        {empty ? (
          <p className="observer-empty">{t("detail.noHistory")}</p>
        ) : (
          <UptimeStrip
            slots={uptime.slots}
            from={uptime.from}
            to={uptime.to}
            pending={pending}
            width={width}
            stripRef={stripRef}
            label={`${t("uptime.availability")} ${
              uptime.availability >= 0 ? `${uptime.availability.toFixed(2)}%` : t("uptime.slotUnknown")
            }`}
          />
        )}
      </div>

      <p className="chrome observer-note">
        {uptime.thresholdMs > 0
          ? t("uptime.note", {
              slot: formatDurationMs(slotMs),
              gap: formatDurationMs(uptime.thresholdMs),
            })
          : t("uptime.noteBasic", { slot: formatDurationMs(slotMs) })}
      </p>
    </div>
  );
}
