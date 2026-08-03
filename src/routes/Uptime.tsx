/**
 * Status-page style availability strips.
 *
 * Komari stores no uptime history — `uptime` is commented out of models.Record
 * — so availability has to be *derived*: bucket the load records into fixed
 * slots and treat a slot with zero records as downtime. That is an inference,
 * not a measurement, which is why the note under the heading says so plainly.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { getLoadRecords } from "@/api/client";
import { useAppStore } from "@/store/app";

const RANGES = [24, 72, 168] as const;
/** Cap concurrent history requests — a 200-node fleet would otherwise stampede. */
const CONCURRENCY = 6;

type SlotState = "online" | "offline" | "unknown";

interface NodeUptime {
  uuid: string;
  name: string;
  slots: SlotState[];
  availability: number;
}

export function UptimePage() {
  const { t } = useTranslation();
  const nodes = useAppStore((s) => s.nodes);
  const recordEnabled = useAppStore((s) => s.publicSettings?.record_enabled ?? true);
  const [hours, setHours] = useState<number>(24);
  const [rows, setRows] = useState<NodeUptime[]>([]);
  const [loading, setLoading] = useState(false);

  // <=24h reads better at 1h resolution; longer windows would produce far too
  // many blocks to fit, so the slot widens with the range.
  const slotMinutes = hours <= 24 ? 60 : hours <= 72 ? 180 : 360;

  const nodeKey = useMemo(() => nodes.map((n) => n.uuid).join(","), [nodes]);

  useEffect(() => {
    if (nodes.length === 0 || !recordEnabled) return;
    let cancelled = false;
    setLoading(true);

    const now = Date.now();
    const slotMs = slotMinutes * 60_000;
    const slotCount = Math.floor((hours * 3_600_000) / slotMs);
    const start = now - slotCount * slotMs;

    async function run() {
      const results: NodeUptime[] = [];
      const queue = [...nodes];

      const worker = async () => {
        while (queue.length > 0 && !cancelled) {
          const node = queue.shift();
          if (!node) break;
          try {
            const data = await getLoadRecords(node.uuid, hours, "cpu");
            const slots: SlotState[] = Array.from({ length: slotCount }, () => "offline");
            let earliest = Infinity;

            for (const record of data.records ?? []) {
              const time = Date.parse(record.time);
              if (!Number.isFinite(time)) continue;
              earliest = Math.min(earliest, time);
              const index = Math.floor((time - start) / slotMs);
              if (index >= 0 && index < slotCount) slots[index] = "online";
            }

            // Slots predating the node's first record are unknown, not down —
            // a node registered yesterday was not "offline" last week.
            if (Number.isFinite(earliest)) {
              const firstKnown = Math.floor((earliest - start) / slotMs);
              for (let i = 0; i < Math.min(firstKnown, slotCount); i++) slots[i] = "unknown";
            } else {
              slots.fill("unknown");
            }

            const known = slots.filter((s) => s !== "unknown");
            const up = known.filter((s) => s === "online").length;
            results.push({
              uuid: node.uuid,
              name: node.name,
              slots,
              availability: known.length ? (up / known.length) * 100 : 0,
            });
          } catch {
            results.push({
              uuid: node.uuid,
              name: node.name,
              slots: Array.from({ length: slotCount }, () => "unknown"),
              availability: 0,
            });
          }
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (cancelled) return;
      results.sort((a, b) => a.name.localeCompare(b.name));
      setRows(results);
      setLoading(false);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [nodeKey, hours, slotMinutes, recordEnabled, nodes]);

  if (!recordEnabled) {
    return <p className="observer-empty">{t("detail.historyDisabled")}</p>;
  }

  return (
    <div className="observer-page">
      <div className="observer-toolbar">
        <h1 className="chrome observer-page-title">{t("uptime.title")}</h1>
        <div className="observer-segmented">
          {RANGES.map((h) => (
            <button key={h} type="button" data-active={hours === h} onClick={() => setHours(h)}>
              {h >= 24 ? t("detail.days", { count: h / 24 }) : t("detail.hours", { count: h })}
            </button>
          ))}
        </div>
      </div>

      <p className="chrome observer-note">{t("uptime.note")}</p>

      {loading && rows.length === 0 ? (
        <p className="observer-empty chrome">…</p>
      ) : (
        <div className="observer-uptime panel">
          {rows.map((row) => (
            <div key={row.uuid} className="observer-uptime-row">
              <Link to={`/node/${row.uuid}`} className="observer-uptime-name">
                {row.name}
              </Link>
              <div className="observer-uptime-strip" role="img" aria-label={`${row.availability.toFixed(2)}%`}>
                {row.slots.map((slot, i) => (
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
              <span className="metric observer-uptime-pct">{row.availability.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
