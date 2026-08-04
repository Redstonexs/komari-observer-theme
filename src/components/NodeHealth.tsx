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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLoadRecords, getPingRecords, getPingTasks } from "@/api/client";
import type { PingRecord, PublicPingTask } from "@/api/types";
import { LineChart, type Series } from "@/components/LineChart";
import { LOSS_THRESHOLDS } from "@/config/settings";
import { useAppStore } from "@/store/app";
import { formatLatency } from "@/lib/format";
import { downsample } from "@/lib/series";

type SlotState = "online" | "offline" | "unknown";

/** Each block owns its own window, so neither control can surprise the other. */
const PING_RANGES = [4, 12, 24, 72] as const;
const UPTIME_RANGES = [24, 72, 168] as const;

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
  const [slots, setSlots] = useState<SlotState[]>([]);
  const [availability, setAvailability] = useState(0);
  const [loading, setLoading] = useState(false);

  // Wider windows need wider buckets or the strip becomes unreadable confetti.
  const slotMinutes = hours <= 24 ? 60 : hours <= 72 ? 180 : 360;

  useEffect(() => {
    if (!recordEnabled) return;
    let cancelled = false;
    setLoading(true);

    const now = Date.now();
    const slotMs = slotMinutes * 60_000;
    const count = Math.floor((hours * 3_600_000) / slotMs);
    const start = now - count * slotMs;

    getLoadRecords(uuid, hours, "cpu")
      .then((data) => {
        if (cancelled) return;
        const next: SlotState[] = Array.from({ length: count }, () => "offline");
        let earliest = Infinity;

        for (const record of data.records ?? []) {
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
        setSlots(next);
        setAvailability(known.length ? (up / known.length) * 100 : 0);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [uuid, hours, slotMinutes, recordEnabled]);

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
      <p className="chrome observer-note">{t("uptime.note")}</p>
    </div>
  );
}
