/**
 * A node's country: flag plus ISO code.
 *
 * Never the flag on its own. Flags come from the system emoji font and Windows
 * ships no glyphs for them — a regional-indicator pair degrades there into two
 * letter tiles a few pixels tall, which is the unreadable marking this replaces.
 * The code carries the meaning; the flag makes it findable at a glance.
 */

import { useTranslation } from "react-i18next";
import { countryName, regionCode, regionFlag } from "@/lib/region";

export function RegionTag({ region, className }: { region: string; className?: string }) {
  const { i18n } = useTranslation();
  const classes = className ? `observer-region ${className}` : "observer-region";
  const code = regionCode(region);

  // Free text the geo table doesn't know ("Tokyo", "us-east-1") is the
  // operator's label for the place — show it, don't drop it.
  if (!code) return <span className={classes}>{region}</span>;

  return (
    <span className={classes} title={countryName(code, i18n.language)}>
      <span className="observer-region-flag" aria-hidden="true">
        {regionFlag(code)}
      </span>
      {code}
    </span>
  );
}
