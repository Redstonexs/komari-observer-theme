/**
 * Per-node latency and availability.
 *
 * Both metrics belong to a node, not to the fleet: a "fleet latency" is not a
 * meaningful number, and a fleet-wide availability percentage hides exactly the
 * one node that was down. So they are rendered here, scoped to a single uuid,
 * and the dashboard-level pages exist only as per-node comparisons.
 *
 * Availability is DERIVED, not measured. Komari keeps no uptime history —
 * `uptime` is commented out of models.Record — so the strip buckets load
 * records into fixed slots and treats a slot with zero records as downtime.
 * That inference is stated in the UI rather than presented as fact.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLoadRecords, getPingRecords, getPingTasks } from "@/api/client";
import type { LoadRecord, PingRecord, PublicPingTask } from "@/api/types";
import { LineChart, type Series } from "@/components/LineChart";
import { LOSS_THRESHOLDS } from "@/config/settings";
import { useAppStore } from "@/store/app";
import { formatLatency } from "@/lib/format";
import { downsample } from "@/lib/series";

type SlotState = "online" | "offline" | "unknown";

/** Each block owns its own window, so neither control can surprise the other. */
const PING_RANGES = [4, 12, 24, 72] as const;
const UPTIME_RANGES = [24, 72, 168] as const;

/** Slot width the availability strip aims for, gap included. */
const SLOT_PITCH_PX = 28;
/** Bucket sizes the strip may pick from, in minutes. A reader can reason about
 *  "3h"; nothing is gained by offering them "3h 37m". */
const SLOT_MINUTES = [30, 60, 90, 120, 180, 240, 360, 720] as const;

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

export function NodeUptime({ uuid }: { uuid: string }) {
  const { t } = useTranslation();
  const recordEnabled = useAppStore((s) => s.publicSettings?.record_enabled ?? true);
  const [hours, setHours] = useState(24);
  // The fetch time travels with the records: bucketing is re-run on resize, and
  // re-anchoring the slots to a newer "now" each time would slide the window
  // out from under the data it is describing.
  const [data, setData] = useState<{ records: LoadRecord[]; fetchedAt: number } | null>(null);
  const [loading, setLoading] = useState(false);

  // The strip spans the page, so a fixed bucket count cannot serve every width:
  // the 24 that read well in a half-width panel stretch into bars across a
  // desktop, and buckets fine enough for a desktop become confetti on a phone.
  // Measured the way LineChart measures its host.
  const hostRef = useRef<HTMLDivElement | null>(null);
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

  const slotMinutes = useMemo(() => {
    const ideal = (hours * 60) / Math.max(8, Math.round(width / SLOT_PITCH_PX));
    // A bucket too small to span several samples turns ordinary cadence jitter
    // into fake downtime. The server hands back ~500 points per window whatever
    // the range, so keep a bucket worth at least ~4 of them.
    const floor = Math.max(30, (4 * hours * 60) / 500);
    const allowed = SLOT_MINUTES.filter((m) => m >= floor);
    return (allowed.length ? allowed : [SLOT_MINUTES[SLOT_MINUTES.length - 1]]).reduce((best, m) =>
      Math.abs(m - ideal) < Math.abs(best - ideal) ? m : best,
    );
  }, [hours, width]);

  useEffect(() => {
    if (!recordEnabled) return;
    let cancelled = false;
    setLoading(true);
    getLoadRecords(uuid, hours, "cpu")
      .then((res) => {
        if (!cancelled) setData({ records: res.records ?? [], fetchedAt: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid, hours, recordEnabled]);

  // Bucketing is pure, so a resize re-slices the records already in hand rather
  // than asking the server for the same window again.
  const { slots, availability } = useMemo(() => {
    const empty = { slots: [] as SlotState[], availability: 0 };
    if (!data) return empty;

    const slotMs = slotMinutes * 60_000;
    const count = Math.floor((hours * 3_600_000) / slotMs);
    const start = data.fetchedAt - count * slotMs;
    const next: SlotState[] = Array.from({ length: count }, () => "offline");
    let earliest = Infinity;

    for (const record of data.records) {
      const time = Date.parse(record.time);
      if (!Number.isFinite(time)) continue;
      earliest = Math.min(earliest, time);
      const index = Math.floor((time - start) / slotMs);
      if (index >= 0 && index < count) next[index] = "online";
    }

    // Before the node's first record it was not "down", it was unknown —
    // a node added yesterday must not read as a week of downtime.
    if (Number.isFinite(earliest)) {
      const firstKnown = Math.floor((earliest - start) / slotMs);
      for (let i = 0; i < Math.min(firstKnown, count); i++) next[i] = "unknown";
    } else {
      next.fill("unknown");
    }

    const known = next.filter((s) => s !== "unknown");
    const up = known.filter((s) => s === "online").length;
    return { slots: next, availability: known.length ? (up / known.length) * 100 : 0 };
  }, [data, hours, slotMinutes]);

  if (!recordEnabled) return null;

  return (
    <div className="observer-chartblock panel">
      <div className="observer-history-head">
        <h3 className="chrome">{t("uptime.title")}</h3>
        <div className="observer-uptime-head-right">
          <span className="metric observer-uptime-pct">{availability.toFixed(2)}%</span>
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
          and the slot count is decided from its width. */}
      <div ref={hostRef} className="observer-uptime-host">
        {loading && slots.length === 0 ? (
          <p className="observer-empty chrome">…</p>
        ) : slots.length === 0 ? (
          <p className="observer-empty">{t("detail.noHistory")}</p>
        ) : (
          <div
            className="observer-uptime-strip observer-uptime-strip-lg"
            role="img"
            aria-label={`${t("uptime.availability")} ${availability.toFixed(2)}%`}
          >
            {slots.map((slot, i) => (
              <span
                key={i}
                className="observer-uptime-slot"
                data-slot={slot}
                title={t(
                  slot === "online"
                    ? "uptime.slotOnline"
                    : slot === "offline"
                      ? "uptime.slotOffline"
                      : "uptime.slotUnknown",
                )}
              />
            ))}
          </div>
        )}
      </div>
      <p className="chrome observer-note">{t("uptime.note")}</p>
    </div>
  );
}
