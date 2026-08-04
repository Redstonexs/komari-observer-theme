import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPingRecords, getPingTasks } from "@/api/client";
import type { PingRecord, PublicPingTask } from "@/api/types";
import { useAppStore } from "@/store/app";
import { LineChart, type Series } from "@/components/LineChart";
import { LOSS_THRESHOLDS } from "@/config/settings";
import { formatLatency } from "@/lib/format";
import { downsample } from "@/lib/series";

const RANGES = [1, 4, 12, 24, 72] as const;

export function PingPage() {
  const { t } = useTranslation();
  const nodes = useAppStore((s) => s.nodes);
  const sensitivity = useAppStore((s) => s.settings.loss_sensitivity);

  const [tasks, setTasks] = useState<PublicPingTask[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [hours, setHours] = useState<number>(4);
  const [records, setRecords] = useState<PingRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getPingTasks()
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
        setTasks(sorted);
        const preferred = sorted.find((task) => task.default_on) ?? sorted[0];
        setTaskId(preferred?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (taskId == null) return;
    let cancelled = false;
    setLoading(true);
    getPingRecords({ taskId, hours })
      .then((data) => {
        if (!cancelled) setRecords(data.records ?? []);
      })
      .catch(() => {
        // A hidden node returns 200 with an empty result rather than an error,
        // so a real failure here just means no data to show.
        if (!cancelled) setRecords([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, hours]);

  const nameByUuid = useMemo(
    () => new Map(nodes.map((n) => [n.uuid, n.name])),
    [nodes],
  );

  const { series, stats } = useMemo(() => {
    const byClient = new Map<string, PingRecord[]>();
    for (const record of records) {
      const list = byClient.get(record.client);
      if (list) list.push(record);
      else byClient.set(record.client, [record]);
    }

    const out: Series[] = [];
    const summary: Array<{
      uuid: string;
      name: string;
      /** Index into `out`. The table is sorted by name afterwards, so a row's
       *  position is NOT its line's position in the chart ramp. */
      slot: number;
      loss: number;
      avg: number;
      min: number;
      max: number;
    }> = [];

    for (const [uuid, list] of byClient) {
      list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

      // A NEGATIVE value encodes packet loss, not a latency. Mapping it to
      // null produces a genuine gap in the line instead of plotting a
      // nonsensical point below the axis.
      const points = list.map((r) => ({
        x: Date.parse(r.time),
        y: r.value < 0 ? null : r.value,
      }));

      const good = list.filter((r) => r.value >= 0).map((r) => r.value);
      const lost = list.length - good.length;

      const slot = out.length;
      // The server caps a ping query at 4000 points PER NODE, so a wide window
      // over a big fleet would otherwise draw a solid block. Only the line is
      // reduced; the loss and latency figures below use every record.
      out.push({
        label: nameByUuid.get(uuid) ?? uuid,
        points: downsample(points),
        filled: false,
      });
      summary.push({
        uuid,
        name: nameByUuid.get(uuid) ?? uuid,
        slot,
        loss: list.length ? (lost / list.length) * 100 : 0,
        avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : -1,
        min: good.length ? Math.min(...good) : -1,
        max: good.length ? Math.max(...good) : -1,
      });
    }

    summary.sort((a, b) => a.name.localeCompare(b.name));
    return { series: out, stats: summary };
  }, [records, nameByUuid]);

  const thresholds = LOSS_THRESHOLDS[sensitivity];

  if (!loading && tasks.length === 0) {
    return <p className="observer-empty">{t("ping.noTasks")}</p>;
  }

  return (
    <div className="observer-page">
      <div className="observer-toolbar">
        <select
          className="observer-select chrome"
          value={taskId ?? ""}
          onChange={(e) => setTaskId(Number(e.target.value))}
          aria-label={t("ping.task")}
        >
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.name} ({task.type})
            </option>
          ))}
        </select>

        <div className="observer-segmented">
          {RANGES.map((h) => (
            <button key={h} type="button" data-active={hours === h} onClick={() => setHours(h)}>
              {h >= 24 ? t("detail.days", { count: h / 24 }) : t("detail.hours", { count: h })}
            </button>
          ))}
        </div>
      </div>

      <div className="observer-chartblock panel">
        <h2 className="chrome">{t("ping.title")}</h2>
        {series.length === 0 ? (
          <p className="observer-empty">{t("detail.noHistory")}</p>
        ) : (
          <LineChart
            series={series}
            height={260}
            formatY={(v) => `${Math.round(v)}ms`}
            ariaLabel={t("ping.title")}
          />
        )}
        <p className="chrome observer-note">{t("ping.lossNote")}</p>
      </div>

      {stats.length > 0 && (
        <div className="observer-tablewrap panel">
          <table className="observer-table">
            <thead>
              <tr className="chrome">
                <th>{t("ping.selectNodes")}</th>
                <th>{t("ping.loss")}</th>
                <th>{t("ping.avg")}</th>
                <th>{t("ping.min")}</th>
                <th>{t("ping.max")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => {
                const level =
                  row.loss >= thresholds.bad ? "bad" : row.loss >= thresholds.warn ? "warn" : "online";
                return (
                  <tr key={row.uuid} data-status={level}>
                    <td>
                      <span className="status-dot" aria-hidden="true" />
                      <span
                        className="observer-legend-swatch"
                        style={{ background: `var(--observer-chart-${(row.slot % 9) + 1})` }}
                        aria-hidden="true"
                      />
                      {row.name}
                    </td>
                    {/* Loss is also stated numerically, so status is never colour-only. */}
                    <td className="metric">{row.loss.toFixed(1)}%</td>
                    <td className="metric">{formatLatency(row.avg)}</td>
                    <td className="metric">{formatLatency(row.min)}</td>
                    <td className="metric">{formatLatency(row.max)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
