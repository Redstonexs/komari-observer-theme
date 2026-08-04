#!/usr/bin/env node
/**
 * Generates src/assets/geo.ts: a bit-packed land mask for the dot-matrix world
 * map, plus an ISO-3166-1 alpha-2 to lat/lon table for placing node markers.
 *
 * Run offline and committed, so the theme ships with no runtime geo dependency
 * and no network calls — a Komari install is frequently on a LAN or air-gapped
 * box, and a map that needs a CDN would simply be blank there.
 *
 * Sources (both public domain / MIT, fetched at generation time only):
 *   - world-atlas countries-110m.json  (Natural Earth, public domain)
 *   - world-countries                  (ODbL, centroids only)
 *
 * Usage: node scripts/make-geo.mjs <countries-110m.json> <world-countries.json>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , topoPath, countriesPath] = process.argv;
if (!topoPath || !countriesPath) {
  console.error("usage: make-geo.mjs <countries-110m.json> <world-countries.json>");
  process.exit(1);
}

/* ---- Grid ---------------------------------------------------------- */

// Longitude spans the globe; latitude is clipped to where land and people
// actually are. Including the poles wastes a third of the canvas on Antarctica
// and stretches everything else — this range gives a ~2.7:1 strip that sits
// well under the summary bar.
const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -56;
const LAT_MAX = 78;
const W = 200;
const H = 74;

/* ---- TopoJSON decoding --------------------------------------------- */

const topo = JSON.parse(readFileSync(topoPath, "utf8"));
const { scale, translate } = topo.transform;

/** Arcs are delta-encoded quantised integers; expand to absolute lon/lat. */
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
});

/** A negative index means "this arc, reversed" — encoded as ~i. */
function arcPoints(index) {
  if (index >= 0) return arcs[index];
  return arcs[~index].slice().reverse();
}

/** Stitches a ring's arc indices into one closed coordinate list. */
function ring(indices) {
  const points = [];
  for (const index of indices) {
    const part = arcPoints(index);
    // Consecutive arcs share an endpoint; drop the duplicate.
    for (let i = points.length ? 1 : 0; i < part.length; i++) points.push(part[i]);
  }
  return unwrap(points);
}

/**
 * Removes antimeridian discontinuities.
 *
 * Landmasses that straddle 180 degrees (Russia, Fiji) are stored with their
 * longitudes wrapped into [-180, 180], so consecutive points jump by ~360.
 * A scanline fill reads that jump as a real edge spanning the whole map and
 * floods entire rows — which is exactly what produced a solid band across the
 * Arctic on the first attempt.
 *
 * Shifting each point by whole turns keeps the ring continuous in an extended
 * longitude space; the fill wraps the resulting columns back with a modulo.
 */
function unwrap(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const previous = out[i - 1][0];
    let lon = points[i][0];
    while (lon - previous > 180) lon -= 360;
    while (previous - lon > 180) lon += 360;
    out.push([lon, points[i][1]]);
  }
  return out;
}

/** Each polygon is [outerRing, ...holes]. */
const polygons = [];

/** world-atlas wraps land in a GeometryCollection, so recurse into it. */
function collect(geometry) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) collect(child);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.arcs) polygons.push(poly.map(ring));
  } else if (geometry.type === "Polygon") {
    polygons.push(geometry.arcs.map(ring));
  }
}
collect(topo.objects.land);

if (polygons.length === 0) {
  console.error("No polygons decoded — the topology shape is not what was expected.");
  process.exit(1);
}

/* ---- Rasterise ------------------------------------------------------ */

const mask = new Uint8Array(W * H);

const LON_SPAN = LON_MAX - LON_MIN;
// Row 0 is the top of the image, which is the HIGHEST latitude.
const cellLat = (row) => LAT_MAX - ((row + 0.5) / H) * (LAT_MAX - LAT_MIN);
/** Fractional column for a longitude, valid outside [-180,180] after unwrapping. */
const lonToCol = (lon) => ((lon - LON_MIN) / LON_SPAN) * W - 0.5;

for (const rings of polygons) {
  for (let row = 0; row < H; row++) {
    const lat = cellLat(row);

    // Scanline fill: collect every edge crossing this latitude, sort the
    // crossings by longitude, then fill between alternating pairs. Handling all
    // of a polygon's rings together makes holes fall out of the even-odd rule
    // for free. This is ~600x faster than point-in-polygon per cell.
    const crossings = [];
    for (const points of rings) {
      for (let i = 0, n = points.length; i < n; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % n];
        if (y1 === y2) continue;
        // Half-open test avoids double-counting shared vertices.
        if (lat >= Math.min(y1, y2) && lat < Math.max(y1, y2)) {
          crossings.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    for (let i = 0; i + 1 < crossings.length; i += 2) {
      // Columns are derived directly from the span and then wrapped, so a
      // ring living in extended longitude space still lands in the right place.
      const from = Math.ceil(lonToCol(crossings[i]));
      const to = Math.floor(lonToCol(crossings[i + 1]));
      if (to - from > W) continue; // degenerate span covering the globe
      for (let c = from; c <= to; c++) {
        const col = ((c % W) + W) % W;
        mask[row * W + col] = 1;
      }
    }
  }
}

/* ---- Pack ----------------------------------------------------------- */

const bytes = new Uint8Array(Math.ceil((W * H) / 8));
let landCells = 0;
for (let i = 0; i < W * H; i++) {
  if (mask[i]) {
    bytes[i >> 3] |= 1 << (i & 7);
    landCells++;
  }
}
const packed = Buffer.from(bytes).toString("base64");

/* ---- Centroids ------------------------------------------------------ */

const countries = JSON.parse(readFileSync(countriesPath, "utf8"));
const latlng = {};
for (const country of countries) {
  const code = country.cca2;
  const coords = country.latlng;
  if (!code || !Array.isArray(coords) || coords.length !== 2) continue;
  latlng[code] = [Number(coords[0].toFixed(2)), Number(coords[1].toFixed(2))];
}

// Komari's `region` is operator-typed, so accept the common non-ISO spellings
// people actually put there.
const ALIASES = {
  UK: "GB",
  EN: "GB",
  SU: "RU",
  AN: "NL",
  TP: "TL",
};

const entries = Object.keys(latlng)
  .sort()
  .map((code) => `  ${code}: [${latlng[code][0]}, ${latlng[code][1]}],`)
  .join("\n");

const out = `/**
 * Generated by scripts/make-geo.mjs — do not edit by hand.
 *
 * LAND is a bit-packed ${W}x${H} land/water mask over the lon/lat window below,
 * used to draw the dot-matrix world map. COUNTRY_LATLNG maps ISO-3166-1
 * alpha-2 codes to a representative point for marker placement.
 *
 * Land data: Natural Earth via world-atlas (public domain).
 * Centroids: world-countries (ODbL).
 */

export const LAND = {
  width: ${W},
  height: ${H},
  lonMin: ${LON_MIN},
  lonMax: ${LON_MAX},
  latMin: ${LAT_MIN},
  latMax: ${LAT_MAX},
  /** Row-major, one bit per cell, LSB first. */
  mask: "${packed}",
} as const;

/** Non-ISO region spellings seen in the wild, mapped onto their ISO code. */
export const REGION_ALIASES: Record<string, string> = ${JSON.stringify(ALIASES, null, 2)};

/** ISO-3166-1 alpha-2 -> [latitude, longitude]. */
export const COUNTRY_LATLNG: Record<string, [number, number]> = {
${entries}
};
`;

writeFileSync("src/assets/geo.ts", out);
console.log(
  `✓ src/assets/geo.ts  ${W}x${H} mask, ${landCells} land cells ` +
    `(${((landCells / (W * H)) * 100).toFixed(1)}%), ${Object.keys(latlng).length} countries, ` +
    `${(out.length / 1024).toFixed(1)} KB`,
);
