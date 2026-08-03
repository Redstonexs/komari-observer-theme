/**
 * i18n setup.
 *
 * Komari supplies no locale API. The only server-side signal is a `language`
 * COOKIE, which the Go server reads to rewrite <html lang> before the page is
 * served (web/public/public.go). The documented client-side key is
 * localStorage `language`. We therefore keep both in sync: localStorage is what
 * this theme reads, the cookie is what the server reads.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import ja from "./locales/ja.json";

export const SUPPORTED = ["en", "zh-CN", "zh-TW", "ja"] as const;
export type Locale = (typeof SUPPORTED)[number];

const LS_KEY = "language";
const COOKIE_KEY = "language";

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function writeCookie(name: string, value: string) {
  // One year, site-wide. Lax is enough: this is a display preference, and the
  // server only uses it to set an html lang attribute.
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
}

/** Maps an arbitrary BCP-47 tag onto one of our bundles. */
function normalize(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const t = tag.replace("_", "-");
  if ((SUPPORTED as readonly string[]).includes(t)) return t as Locale;

  const lower = t.toLowerCase();
  if (lower.startsWith("zh")) {
    // Traditional-script regions; everything else Chinese falls to Simplified.
    return /hant|tw|hk|mo/.test(lower) ? "zh-TW" : "zh-CN";
  }
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("en")) return "en";
  return null;
}

function detect(): Locale {
  const fromQuery = new URLSearchParams(window.location.search).get("lang");
  const stored = (() => {
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  })();

  return (
    normalize(fromQuery) ??
    normalize(stored) ??
    normalize(readCookie(COOKIE_KEY)) ??
    normalize(navigator.language) ??
    "en"
  );
}

const initial = detect();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    "zh-TW": { translation: zhTW },
    ja: { translation: ja },
  },
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLocale(locale: Locale) {
  void i18n.changeLanguage(locale);
  try {
    localStorage.setItem(LS_KEY, locale);
  } catch {
    /* storage unavailable */
  }
  // Keeps the server-rendered <html lang> correct on the next full load.
  writeCookie(COOKIE_KEY, locale);
  document.documentElement.lang = locale;
}

// Align the attribute with what we actually resolved on this load.
document.documentElement.lang = initial;

export default i18n;
