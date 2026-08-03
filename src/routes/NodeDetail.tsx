import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { getLoadRecords } from "@/api/client";
import type { LoadRecordsResponse, NodeInfo } from "@/api/types";
import { useAppStore } from "@/store/app";
import { useLiveNode } from "@/hooks/useLiveNode";
import { LineChart, type Series } from "@/components/LineChart";
import { Gauge, type GaugeHandle } from "@/components/Gauge";
import {
  daysUntil,
  formatBytes,
  formatPrice,
  formatRate,
  formatUptime,
  parseTags,
} from "@/lib/format";
import { diskPercent, memPercent } from "@/api/model";

const RANGES = [1, 4, 12, 24, 72, 168] as const;

export function NodeDetail() {
  const { uuid = "" } = useParams();
  const { t } = useTranslation();
  const nodes = useAppStore((s) => s.nodes);
  const showBilling = useAppStore((s) => s.settings.show_billing);
  const recordEnabled = useAppStore((s) => s.publicSettings?.record_enabled ?? true);

  const node = useMemo(() => nodes.find((n) => n.uuid === uuid), [nodes, uuid]);
  const [hours, setHours] = useState<number>(4);
  const [history, setHistory] = useState<LoadRecordsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!uuid || !recordEnabled) return;
    let cancelled = false;
    setLoading(true);
    // load_type is omitted deliberately: passing "gpu" is rejected by the
    // server's allowlist, and the full response is the only way to receive the
    // gpu_devices block.
    getLoadRecords(uuid, hours)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid, hours, recordEnabled]);

  if (!node) {
    return (
      <div className="observer-notice panel">
        <h2>{t("detail.notFound")}</h2>
        <Link className="observer-button" to="/">
          {t("nav.back")}
        </Link>
      </div>
    );
  }

  const records = history?.records ?? [];
  const toSeries = (
    label: string,
    pick: (r: (typeof records)[number]) => number,
    filled = true,
  ): Series => ({
    label,
    filled,
    points: records.map((r) => ({ x: Date.parse(r.time), y: pick(r) })),
  });

  return (
    <div className="observer-page">
      <div className="observer-detail-head">
        <Link to="/" className="chrome observer-back">
          &larr; {t("nav.back")}
        </Link>
        <h1 className="observer-detail-title">{node.name}</h1>
        <LiveHeadline uuid={uuid} />
      </div>

      <section className="observer-detail-grid">
        <InfoPanel title={t("detail.hardware")}>
          <Row label={t("detail.cpuModel")} value={node.cpu_name} />
          <Row
            label={t("detail.cores")}
            value={
              node.cpu_physical_cores && node.cpu_physical_cores !== node.cpu_cores
                ? `${node.cpu_cores} (${node.cpu_physical_cores}P)`
                : String(node.cpu_cores)
            }
          />
          <Row label={t("detail.arch")} value={node.arch} />
          <Row label={t("detail.virtualization")} value={node.virtualization} />
          {node.gpu_name && <Row label={t("detail.gpuModel")} value={node.gpu_name} />}
          <Row label={t("detail.memory")} value={formatBytes(node.mem_total)} />
          <Row label={t("detail.swap")} value={formatBytes(node.swap_total)} />
          <Row label={t("detail.disk")} value={formatBytes(node.disk_total)} />
        </InfoPanel>

        <InfoPanel title={t("detail.system")}>
          <Row label={t("detail.os")} value={node.os} />
          <Row label={t("detail.kernel")} value={node.kernel_version} />
          <Row label={t("detail.region")} value={node.region} />
          <Row label={t("detail.group")} value={node.group} />
          <Row label={t("detail.tags")} value={parseTags(node.tags).join(", ")} />
          {node.public_remark && <Row label="" value={node.public_remark} />}
        </InfoPanel>

        <LiveNetworkPanel uuid={uuid} node={node} />

        {showBilling && (node.price > 0 || node.expired_at) && (
          <InfoPanel title={t("detail.billing")}>
            {node.price > 0 && (
              <Row
                label={t("detail.price")}
                value={formatPrice(node.price, node.currency, node.billing_cycle)}
              />
            )}
            {node.expired_at && <ExpiryRow iso={node.expired_at} />}
            {node.traffic_limit > 0 && (
              <Row
                label={t("detail.trafficLimit")}
                value={`${formatBytes(node.traffic_limit)} (${node.traffic_limit_type})`}
              />
            )}
          </InfoPanel>
        )}
      </section>

      <section className="observer-history">
        <div className="observer-history-head">
          <h2 className="chrome">{t("detail.history")}</h2>
          <div className="observer-segmented">
            {RANGES.map((h) => (
              <button key={h} type="button" data-active={hours === h} onClick={() => setHours(h)}>
                {h >= 24 ? t("detail.days", { count: h / 24 }) : t("detail.hours", { count: h })}
              </button>
            ))}
          </div>
        </div>

        {!recordEnabled ? (
          <p className="observer-empty">{t("detail.historyDisabled")}</p>
        ) : loading && records.length === 0 ? (
          <p className="observer-empty chrome">…</p>
        ) : records.length === 0 ? (
          <p className="observer-empty">{t("detail.noHistory")}</p>
        ) : (
          <div className="observer-charts">
            <ChartBlock title={t("card.cpu")}>
              <LineChart
                series={[toSeries(t("card.cpu"), (r) => r.cpu)]}
                maxY={100}
                formatY={(v) => `${Math.round(v)}%`}
                ariaLabel={t("card.cpu")}
              />
            </ChartBlock>

            <ChartBlock title={t("card.memory")}>
              <LineChart
                series={[
                  toSeries(t("card.memory"), (r) =>
                    r.ram_total > 0 ? (r.ram / r.ram_total) * 100 : 0,
                  ),
                ]}
                maxY={100}
                formatY={(v) => `${Math.round(v)}%`}
                ariaLabel={t("card.memory")}
              />
            </ChartBlock>

            <ChartBlock title={t("card.network")}>
              <LineChart
                series={[
                  { ...toSeries("↓", (r) => r.net_in, false) },
                  { ...toSeries("↑", (r) => r.net_out, false) },
                ]}
                formatY={(v) => formatRate(v)}
                ariaLabel={t("card.network")}
              />
            </ChartBlock>

            <ChartBlock title={t("card.load")}>
              <LineChart
                series={[toSeries(t("card.load"), (r) => r.load)]}
                formatY={(v) => v.toFixed(1)}
                ariaLabel={t("card.load")}
              />
            </ChartBlock>

            {history?.has_gpu_data && history.gpu_devices && (
              <ChartBlock title={t("card.gpu")}>
                <LineChart
                  series={Object.values(history.gpu_devices).map((device) => ({
                    label: device.device_name || `GPU ${device.device_index}`,
                    filled: false,
                    points: device.records.map((r) => ({
                      x: Date.parse(r.time),
                      y: r.utilization,
                    })),
                  }))}
                  maxY={100}
                  formatY={(v) => `${Math.round(v)}%`}
                  ariaLabel={t("card.gpu")}
                />
              </ChartBlock>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** Live gauges at the top of the detail page. */
function LiveHeadline({ uuid }: { uuid: string }) {
  const { t } = useTranslation();
  const cpu = useRef<GaugeHandle | null>(null);
  const mem = useRef<GaugeHandle | null>(null);
  const disk = useRef<GaugeHandle | null>(null);
  const uptimeRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLiveNode(uuid, (record) => {
    const root = rootRef.current;
    if (root) root.dataset.status = record?.online ? "online" : "offline";
    cpu.current?.set(record?.online ? record.cpu : 0);
    mem.current?.set(record?.online ? memPercent(record) : 0);
    disk.current?.set(record?.online ? diskPercent(record) : 0);
    if (uptimeRef.current) {
      uptimeRef.current.textContent = record?.online ? formatUptime(record.uptime) : "—";
    }
  });

  return (
    <div ref={rootRef} className="observer-detail-live" data-status="offline">
      <span className="status-dot" aria-hidden="true" />
      <Gauge ref={cpu} label={t("card.cpu")} size={64} />
      <Gauge ref={mem} label={t("card.memory")} size={64} />
      <Gauge ref={disk} label={t("card.disk")} size={64} />
      <div className="observer-detail-uptime">
        <span className="chrome">{t("card.uptime")}</span>
        <span ref={uptimeRef} className="metric">
          —
        </span>
      </div>
    </div>
  );
}

function LiveNetworkPanel({ uuid, node }: { uuid: string; node: NodeInfo }) {
  const { t } = useTranslation();
  const upRef = useRef<HTMLSpanElement | null>(null);
  const downRef = useRef<HTMLSpanElement | null>(null);
  const totalUpRef = useRef<HTMLSpanElement | null>(null);
  const totalDownRef = useRef<HTMLSpanElement | null>(null);
  const connRef = useRef<HTMLSpanElement | null>(null);
  const procRef = useRef<HTMLSpanElement | null>(null);

  useLiveNode(uuid, (record) => {
    const write = (ref: React.RefObject<HTMLSpanElement | null>, value: string) => {
      if (ref.current) ref.current.textContent = value;
    };
    if (!record?.online) {
      for (const ref of [upRef, downRef, totalUpRef, totalDownRef, connRef, procRef]) {
        write(ref, "—");
      }
      return;
    }
    write(upRef, `${formatRate(record.net_out)}/s`);
    write(downRef, `${formatRate(record.net_in)}/s`);
    write(totalUpRef, formatBytes(record.net_total_up));
    write(totalDownRef, formatBytes(record.net_total_down));
    write(connRef, `${record.connections} / ${record.connections_udp}`);
    write(procRef, String(record.process));
  });

  return (
    <InfoPanel title={t("detail.network")}>
      <RefRow label="↑" valueRef={upRef} />
      <RefRow label="↓" valueRef={downRef} />
      <RefRow label={t("detail.totalUp")} valueRef={totalUpRef} />
      <RefRow label={t("detail.totalDown")} valueRef={totalDownRef} />
      <RefRow label={`${t("card.connections")} (TCP/UDP)`} valueRef={connRef} />
      <RefRow label={t("card.process")} valueRef={procRef} />
      {node.region && <Row label={t("detail.region")} value={node.region} />}
    </InfoPanel>
  );
}

function InfoPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="observer-infopanel panel">
      <h2 className="chrome">{title}</h2>
      <dl>{children}</dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="observer-row">
      <dt className="chrome">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RefRow({
  label,
  valueRef,
}: {
  label: string;
  valueRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="observer-row">
      <dt className="chrome">{label}</dt>
      <dd className="metric">
        <span ref={valueRef}>—</span>
      </dd>
    </div>
  );
}

function ExpiryRow({ iso }: { iso: string }) {
  const { t } = useTranslation();
  const days = daysUntil(iso);
  const date = new Date(iso).toLocaleDateString();
  return (
    <div className="observer-row" data-warn={days !== null && days <= 7 ? "true" : undefined}>
      <dt className="chrome">{t("detail.expires")}</dt>
      <dd className="metric">
        {days !== null && days < 0 ? t("detail.expired") : date}
        {days !== null && days >= 0 && (
          <span className="observer-row-note"> {t("detail.inDays", { count: days })}</span>
        )}
      </dd>
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="observer-chartblock panel">
      <h3 className="chrome">{title}</h3>
      {children}
    </div>
  );
}
