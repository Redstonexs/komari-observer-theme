/**
 * A node's country: flag plus ISO code.
 *
 * The flag is real artwork, not the emoji for the country. Emoji flags come
 * from the system font and Windows ships no glyphs for them — a regional
 * indicator pair degrades there into two letter tiles a few pixels tall, which
 * is the unreadable marking this replaces. Drawing them ourselves is the only
 * way the marker looks the same everywhere it is read.
 *
 * The code stays regardless. It carries the meaning when the picture is too
 * small to tell two tricolours apart, and it is what remains if the image
 * cannot be fetched at all.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { flagUrl } from "@/lib/flags";
import { countryName, regionCode } from "@/lib/region";

export function RegionTag({ region, className }: { region: string; className?: string }) {
  const { i18n } = useTranslation();
  const classes = className ? `observer-region ${className}` : "observer-region";
  const code = regionCode(region);

  // Free text the geo table doesn't know ("Tokyo", "us-east-1") is the
  // operator's label for the place — show it, don't drop it.
  if (!code) return <span className={classes}>{region}</span>;

  return (
    <span className={classes} title={countryName(code, i18n.language)}>
      <Flag key={code} code={code} />
      {code}
    </span>
  );
}

/**
 * Keyed by code at the call site: the failure below is about one country's
 * artwork, so it has to be forgotten when the row starts showing another.
 */
function Flag({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  const src = flagUrl(code);
  if (!src || failed) return null;

  return (
    <img
      className="observer-region-flag"
      src={src}
      // Decorative: the code sits right beside it, and "flag of Japan JP" is
      // noise to read out.
      alt=""
      loading="lazy"
      decoding="async"
      // Komari answers a missing asset with index.html rather than a 404, so a
      // stale reference arrives as an undecodable image. Drop it rather than
      // leaving a broken-image icon in the middle of a table.
      onError={() => setFailed(true)}
    />
  );
}
