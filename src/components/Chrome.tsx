/** Page chrome: header, nav, display settings, footer. */

import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store/app";
import { SUPPORTED, setLocale, type Locale } from "@/i18n";
import { bootTimeline } from "@/anim/gsap";
import { ConnectionBadge } from "./ConnectionBadge";
import type { Appearance } from "@/config/settings";

export function Header() {
  const { t } = useTranslation();
  const sitename = useAppStore((s) => s.publicSettings?.sitename ?? "Komari");
  const bootEnabled = useAppStore((s) => s.settings.enable_boot_sequence);
  const ref = useRef<HTMLElement | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !bootEnabled) return;
    const tl = bootTimeline(el);
    // Kill on unmount so a fast route change cannot leave a half-played
    // timeline writing to detached nodes.
    return () => {
      tl.kill();
    };
  }, [bootEnabled]);

  return (
    <header ref={ref} className="observer-header">
      <div className="observer-header-inner">
        <Link to="/" className="observer-brand" data-boot="brand">
          <span className="observer-brand-mark" aria-hidden="true" />
          <span className="observer-brand-name">{sitename}</span>
        </Link>

        <nav className="observer-nav" data-boot="chrome">
          <NavLink to="/" end className="observer-navlink">
            {t("nav.dashboard")}
          </NavLink>
          <NavLink to="/ping" className="observer-navlink">
            {t("nav.ping")}
          </NavLink>
          <NavLink to="/uptime" className="observer-navlink">
            {t("nav.uptime")}
          </NavLink>
        </nav>

        <div className="observer-header-right" data-boot="chrome">
          <ConnectionBadge />
          <button
            type="button"
            className="observer-iconbtn"
            aria-label={t("settings.title")}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <GearIcon />
          </button>
        </div>
      </div>
      <div className="observer-rule" data-boot="rule" aria-hidden="true" />
      {panelOpen && <SettingsPanel onClose={() => setPanelOpen(false)} />}
    </header>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const appearance = useAppStore((s) => s.appearance);
  const setAppearance = useAppStore((s) => s.setAppearance);
  const allowBackground = useAppStore((s) => s.settings.allow_visitor_background);
  const override = useAppStore((s) => s.backgroundOverride);
  const setOverride = useAppStore((s) => s.setBackgroundOverride);
  const [custom, setCustom] = useState(
    override && /^https?:\/\//i.test(override) ? override : "",
  );
  const ref = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click and on Escape — a panel that traps the user is
  // worse than no panel.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const appearances: Appearance[] = ["light", "dark", "system"];
  const backgrounds = ["", "none", "aurora", "starfield", "grid"];
  const bgLabel: Record<string, string> = {
    "": t("settings.bgDefault"),
    none: t("settings.bgNone"),
    aurora: t("settings.bgAurora"),
    starfield: t("settings.bgStarfield"),
    grid: t("settings.bgGrid"),
  };

  return (
    <div ref={ref} className="observer-settings panel panel-raised" role="dialog">
      <section>
        <h3 className="chrome">{t("settings.appearance")}</h3>
        <div className="observer-segmented">
          {appearances.map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={appearance === mode}
              onClick={() => setAppearance(mode)}
            >
              {t(`settings.${mode}`)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="chrome">{t("settings.language")}</h3>
        <div className="observer-segmented observer-segmented-wrap">
          {SUPPORTED.map((locale) => (
            <button
              key={locale}
              type="button"
              data-active={i18n.language === locale}
              onClick={() => setLocale(locale as Locale)}
            >
              {locale}
            </button>
          ))}
        </div>
      </section>

      {allowBackground && (
        <section>
          <h3 className="chrome">{t("settings.background")}</h3>
          <div className="observer-segmented observer-segmented-wrap">
            {backgrounds.map((mode) => (
              <button
                key={mode || "default"}
                type="button"
                data-active={(override ?? "") === mode}
                onClick={() => setOverride(mode === "" ? null : mode)}
              >
                {bgLabel[mode]}
              </button>
            ))}
          </div>
          <div className="observer-field">
            <input
              type="url"
              value={custom}
              placeholder={t("settings.bgCustom")}
              onChange={(e) => setCustom(e.target.value)}
              aria-label={t("settings.bgCustom")}
            />
            <button
              type="button"
              onClick={() => setOverride(custom.trim() ? custom.trim() : null)}
            >
              {t("settings.bgApply")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export function Footer() {
  const { t } = useTranslation();
  const extra = useAppStore((s) => s.settings.footer_text);
  const version = useAppStore((s) => s.serverVersion);

  return (
    <footer className="observer-footer">
      <div className="observer-rule" aria-hidden="true" />
      <div className="observer-footer-inner chrome">
        {/* Required attribution — do not remove. */}
        <span>{t("footer.poweredBy")}</span>
        <span className="observer-footer-sep">·</span>
        <span>{t("footer.theme")}</span>
        {version && (
          <>
            <span className="observer-footer-sep">·</span>
            <span className="metric">v{version}</span>
          </>
        )}
        {extra && (
          <>
            <span className="observer-footer-sep">·</span>
            <span>{extra}</span>
          </>
        )}
      </div>
    </footer>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
