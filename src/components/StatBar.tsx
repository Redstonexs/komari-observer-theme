/**
 * Fleet totals. Updates imperatively on every tick like the cards do.
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLiveFleet } from "@/hooks/useLiveNode";
import { useAppStore } from "@/store/app";
import { formatBytes, formatRate } from "@/lib/format";
import { useCountTo } from "@/anim/gsap";

// Module-level so their identity is stable across renders — useCountTo rebuilds
// its tween whenever the formatter changes.
const percent = (v: number) => `${v.toFixed(1)}%`;
const wholePercent = (v: number) => (v > 0 ? `${Math.round(v)}%` : "—");

export function StatBar() {
  const { t } = useTranslation();
  const show = useAppStore((s) => s.settings.show_stat_bar);
  const nodeCount = useAppStore((s) => s.nodes.length);

  const onlineRef = useRef<HTMLSpanElement | null>(null);
  const netRef = useRef<HTMLSpanElement | null>(null);
  const trafficRef = useRef<HTMLSpanElement | null>(null);

  // Percentages tween; byte counts and the online tally snap. Interpolating a
  // formatted size like "8.4T" just produces nonsense intermediate values.
  const cpu = useCountTo(percent);
  const mem = useCountTo(wholePercent);

  useLiveFleet((snapshot) => {
    const records = Object.values(snapshot);
    const online = records.filter((r) => r.online);

    // Averages over ONLINE nodes only — including offline zeros would make a
    // partially-down fleet look idle rather than broken.
    const cpuAvg = online.length
      ? online.reduce((sum, r) => sum + r.cpu, 0) / online.length
      : 0;

    let ramUsed = 0;
    let ramTotal = 0;
    let rate = 0;
    let traffic = 0;
    for (const r of online) {
      ramUsed += r.ram;
      ramTotal += r.ram_total;
      rate += r.net_in + r.net_out;
      traffic += r.net_total_up + r.net_total_down;
    }

    if (onlineRef.current) onlineRef.current.textContent = `${online.length}/${records.length || nodeCount}`;
    cpu.set(cpuAvg);
    mem.set(ramTotal ? (ramUsed / ramTotal) * 100 : 0);
    if (netRef.current) netRef.current.textContent = `${formatRate(rate)}/s`;
    if (trafficRef.current) trafficRef.current.textContent = formatBytes(traffic);
  });

  if (!show) return null;

  return (
    <div className="observer-statbar panel" data-boot="chrome">
      <Stat label={t("stat.online")} valueRef={onlineRef} />
      <Stat label={t("stat.cpu")} valueRef={cpu.ref as React.RefObject<HTMLSpanElement | null>} />
      <Stat label={t("stat.memory")} valueRef={mem.ref as React.RefObject<HTMLSpanElement | null>} />
      <Stat label={t("stat.network")} valueRef={netRef} />
      <Stat label={t("stat.traffic")} valueRef={trafficRef} />
    </div>
  );
}

function Stat({
  label,
  valueRef,
}: {
  label: string;
  valueRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="observer-stat">
      <span className="chrome observer-stat-label">{label}</span>
      <span ref={valueRef} className="metric observer-stat-value">
        —
      </span>
    </div>
  );
}
