/**
 * Surfaces which transport is carrying data and whether it has gone stale.
 *
 * This is not decoration. Komari's browser sockets have no server-side read
 * deadline and never push, so a half-open connection reports readyState OPEN
 * indefinitely while delivering nothing — the browser's own connection state
 * is actively misleading. The freshness clock is the only honest signal.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store/app";
import { formatAge } from "@/lib/format";

export function ConnectionBadge() {
  const { t } = useTranslation();
  const link = useAppStore((s) => s.link);
  const show = useAppStore((s) => s.settings.show_connection_badge);
  const [, tick] = useState(0);

  // The age label must advance even when no data arrives — that is precisely
  // the case it exists to make visible.
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!show) return null;

  const tone =
    link.state === "live"
      ? "ok"
      : link.state === "degraded" || link.state === "connecting"
        ? "warn"
        : "bad";

  const title = [
    `${t("link.tier")}: ${link.label}`,
    link.lastGoodAt ? `${t("link.lastUpdate")}: ${formatAge(link.lastGoodAt)}` : null,
    link.lastError,
    t("link.explain"),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="observer-link" data-tone={tone} title={title}>
      <span className="observer-link-dot" aria-hidden="true" />
      <span className="chrome observer-link-state">{t(`link.${link.state}`)}</span>
      {/* The transport label is the tell for "we quietly stepped down". */}
      <span className="chrome observer-link-tier">{link.label}</span>
    </div>
  );
}
