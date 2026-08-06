/**
 * Usage thresholds, in one place.
 *
 * A card can show the same metric twice — a radial gauge and a linear meter —
 * and two instruments turning amber at different values reads as a bug rather
 * than as two views of one number. So the thresholds live here and every
 * consumer defaults to them.
 *
 * The levels are deliberately generous: 75% of memory in use is normal
 * operation on a well-packed box, and a bar that sits amber all day teaches an
 * operator to ignore it.
 */

export type UsageLevel = "ok" | "warn" | "bad";

/** Percent at which a usage reading stops being routine. */
export const USAGE_WARN = 75;
/** Percent at which it needs attention. */
export const USAGE_BAD = 90;

export function usageLevel(
  percent: number,
  warnAt = USAGE_WARN,
  badAt = USAGE_BAD,
): UsageLevel {
  return percent >= badAt ? "bad" : percent >= warnAt ? "warn" : "ok";
}
