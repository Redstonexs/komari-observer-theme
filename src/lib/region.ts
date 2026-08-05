/**
 * The `region` field, resolved to a country.
 *
 * Komari stores region as free text and operators fill it three different ways:
 * an ISO-3166 alpha-2 code ("JP"), a non-ISO spelling ("UK"), or a flag emoji
 * pasted in from somewhere else ("🇯🇵"). All three name the same country and
 * have to resolve to the same code — the emoji form especially, because a bare
 * flag is unreadable wherever the platform has no glyph for it.
 *
 * Anything that does not resolve to a known country is reported as unknown
 * rather than guessed at, and shown as the operator typed it.
 */

import { COUNTRY_LATLNG, REGION_ALIASES } from "@/assets/geo";

/** 🇦. Regional indicators are the alphabet, offset into their own block. */
const INDICATOR_A = 0x1f1e6;
const LETTER_A = "A".charCodeAt(0);

/**
 * "🇯🇵" -> "JP"; null when the value holds no flag.
 *
 * Scans rather than requiring the whole value to be the flag: "🇯🇵 JP" and
 * "🇯🇵 Tokyo" are both things operators type, and both name the same country.
 */
function decodeFlag(value: string): string | null {
  // Spread, not index access: an indicator is a surrogate pair, so value[0]
  // would hand back half a code point.
  const points = [...value].map((ch) => (ch.codePointAt(0) ?? 0) - INDICATOR_A);
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    if (a >= 0 && a <= 25 && b >= 0 && b <= 25) {
      return String.fromCharCode(LETTER_A + a, LETTER_A + b);
    }
  }
  return null;
}

/**
 * An operator-typed region as an ISO alpha-2 code, or null if it names no
 * country this build knows about.
 */
export function regionCode(region: string): string | null {
  const raw = region.trim();
  if (!raw) return null;
  const code = decodeFlag(raw) ?? raw.toUpperCase();
  const resolved = REGION_ALIASES[code] ?? code;
  return COUNTRY_LATLNG[resolved] ? resolved : null;
}

/** One formatter per locale — a fleet table asks for this once per row. */
const NAMES = new Map<string, Intl.DisplayNames | null>();

/** The country's name in the reader's language, e.g. "Japan" / "日本". */
export function countryName(code: string, locale: string): string | undefined {
  if (!NAMES.has(locale)) {
    try {
      NAMES.set(locale, new Intl.DisplayNames([locale], { type: "region" }));
    } catch {
      // An unsupported locale tag is not worth failing a render over.
      NAMES.set(locale, null);
    }
  }
  try {
    return NAMES.get(locale)?.of(code);
  } catch {
    return undefined;
  }
}
