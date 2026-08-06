/**
 * A single node card.
 *
 * This component renders ONCE per structural change. Every live value is
 * written imperatively from the tick callback, so a 100-node grid updating
 * every 2 seconds does zero React work.
 */

import { useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { NodeInfo } from "@/api/types";
import type { LiveRecord } from "@/api/model";
import { diskPercent, memPercent } from "@/api/model";
import { useLiveNode } from "@/hooks/useLiveNode";
import { formatBytes, formatRate, formatUptime, parseTags } from "@/lib/format";
import { pulse, scrambleIn } from "@/anim/gsap";
import { Gauge, type GaugeHandle } from "./Gauge";
import { Meter, type MeterHandle } from "./Meter";
import { RegionTag } from "./RegionTag";
import { Sparkline, type SparklineHandle } from "./Sparkline";
import { useAppStore } from "@/store/app";

interface NodeCardProps {
  node: NodeInfo;
}

export function NodeCard({ node }: NodeCardProps) {
  const { t } = useTranslation();
  const enablePulse = useAppStore((s) => s.settings.enable_pulse);
  const enableScramble = useAppStore((s) => s.settings.enable_scramble);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLAnchorElement | null>(null);
  const cpuGauge = useRef<GaugeHandle | null>(null);
  const memGauge = useRef<GaugeHandle | null>(null);
  const diskGauge = useRef<GaugeHandle | null>(null);
  const cpuMeter = useRef<MeterHandle | null>(null);
  const memMeter = useRef<MeterHandle | null>(null);
  const diskMeter = useRef<MeterHandle | null>(null);
  const netSpark = useRef<SparklineHandle | null>(null);

  const upRef = useRef<HTMLSpanElement | null>(null);
  const downRef = useRef<HTMLSpanElement | null>(null);
  const cpuTextRef = useRef<HTMLSpanElement | null>(null);
  const memTextRef = useRef<HTMLSpanElement | null>(null);
  const diskTextRef = useRef<HTMLSpanElement | null>(null);
  const uptimeRef = useRef<HTMLSpanElement | null>(null);
  const loadRef = useRef<HTMLSpanElement | null>(null);

  // Tracked to fire the pulse only on a *material* change, not on every tick.
  const lastCpu = useRef(-1);
  const scrambled = useRef(false);

  useLiveNode(node.uuid, (record: LiveRecord | undefined) => {
    const root = rootRef.current;
    if (!root) return;

    const online = record?.online ?? false;
    const status = online ? "online" : "offline";
    if (root.dataset.status !== status) {
      root.dataset.status = status;
      // Only pulse on the transition, so a flapping node does not strobe.
      if (online) pulse(root, enablePulse);
    }

    if (!record || !online) {
      cpuGauge.current?.set(0);
      memGauge.current?.set(0);
      diskGauge.current?.set(0);
      cpuMeter.current?.set(0);
      memMeter.current?.set(0);
      diskMeter.current?.set(0);
      if (upRef.current) upRef.current.textContent = "—";
      if (downRef.current) downRef.current.textContent = "—";
      // Blanked with everything else: an emptied bar beside a stale byte count
      // reads as "this box just freed all its memory", not as "no data".
      if (cpuTextRef.current) cpuTextRef.current.textContent = "—";
      if (memTextRef.current) memTextRef.current.textContent = "—";
      if (diskTextRef.current) diskTextRef.current.textContent = "—";
      if (uptimeRef.current) uptimeRef.current.textContent = "—";
      if (loadRef.current) loadRef.current.textContent = "—";
      return;
    }

    const mem = memPercent(record);
    const disk = diskPercent(record);

    cpuGauge.current?.set(record.cpu);
    memGauge.current?.set(mem);
    diskGauge.current?.set(disk);
    cpuMeter.current?.set(record.cpu);
    memMeter.current?.set(mem);
    diskMeter.current?.set(disk);

    // Combined throughput reads better at card size than two overlaid series.
    netSpark.current?.push(record.net_in + record.net_out);

    if (upRef.current) upRef.current.textContent = formatRate(record.net_out);
    if (downRef.current) downRef.current.textContent = formatRate(record.net_in);
    if (cpuTextRef.current) cpuTextRef.current.textContent = `${record.cpu.toFixed(1)}%`;
    if (memTextRef.current) {
      memTextRef.current.textContent = `${formatBytes(record.ram)}/${formatBytes(record.ram_total)}`;
    }
    if (diskTextRef.current) {
      diskTextRef.current.textContent = `${formatBytes(record.disk)}/${formatBytes(record.disk_total)}`;
    }
    if (uptimeRef.current) uptimeRef.current.textContent = formatUptime(record.uptime);
    if (loadRef.current) loadRef.current.textContent = record.load.toFixed(2);

    if (Math.abs(record.cpu - lastCpu.current) > 12) pulse(root, enablePulse);
    lastCpu.current = record.cpu;

    if (!scrambled.current && nameRef.current) {
      scrambled.current = true;
      scrambleIn(nameRef.current, node.name, enableScramble);
    }
  });

  const tags = parseTags(node.tags);

  return (
    <div ref={rootRef} className="observer-card panel" data-status="offline" data-node={node.uuid}>
      <header className="observer-card-head">
        <span className="status-dot" aria-hidden="true" />
        <Link ref={nameRef} to={`/node/${node.uuid}`} className="observer-card-name">
          {node.name}
        </Link>
        {node.region && (
          <RegionTag region={node.region} className="chrome observer-card-region" />
        )}
      </header>

      <div className="observer-card-gauges">
        <Gauge ref={cpuGauge} label={t("card.cpu")} />
        <Gauge ref={memGauge} label={t("card.memory")} />
        <Gauge ref={diskGauge} label={t("card.disk")} />
      </div>

      {/* Meters beside the dials rather than instead of them: the dial says what
          the number is, the bar says how full that leaves the box, and the bar
          is the only one of the two that survives into the compact view. */}
      <div className="observer-meters observer-card-meters">
        <span className="chrome observer-meterrow-cpu">{t("card.cpu")}</span>
        <Meter ref={cpuMeter} label={t("card.cpu")} className="observer-meterrow-cpu" />
        <span ref={cpuTextRef} className="metric observer-meter-value observer-meterrow-cpu">
          —
        </span>

        <span className="chrome">{t("card.memory")}</span>
        <Meter ref={memMeter} label={t("card.memory")} />
        <span ref={memTextRef} className="metric observer-meter-value">
          —
        </span>

        <span className="chrome">{t("card.disk")}</span>
        <Meter ref={diskMeter} label={t("card.disk")} />
        <span ref={diskTextRef} className="metric observer-meter-value">
          —
        </span>
      </div>

      <dl className="observer-card-stats">
        <div>
          <dt className="chrome">{t("card.load")}</dt>
          <dd className="metric">
            <span ref={loadRef}>—</span>
          </dd>
        </div>
        <div>
          <dt className="chrome">{t("card.uptime")}</dt>
          <dd className="metric">
            <span ref={uptimeRef}>—</span>
          </dd>
        </div>
      </dl>

      <div className="observer-card-net">
        <Sparkline ref={netSpark} width={140} height={26} />
        <div className="observer-card-rates metric">
          <span className="observer-rate-up">
            &uarr;<span ref={upRef}>—</span>
          </span>
          <span className="observer-rate-down">
            &darr;<span ref={downRef}>—</span>
          </span>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="observer-card-tags">
          {tags.slice(0, 4).map((tag) => (
            <span key={tag} className="observer-tag chrome">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
