#!/usr/bin/env node
/**
 * Generates src/assets/flags/<code>.svg: one 4:3 flag per country the geo table
 * knows about.
 *
 * Run offline and committed, for the same reason as the geo tables — a Komari
 * install is frequently on a LAN or an air-gapped box, so a flag that needs the
 * Iconify CDN would simply be blank there.
 *
 * The set is driven by COUNTRY_LATLNG rather than by the icon package: that map
 * is exactly what `regionCode()` will resolve an operator's region field to, so
 * generating from it guarantees every code the UI can produce has artwork, and
 * that no artwork ships for a code the UI can never produce. The script fails
 * loudly if the icon set cannot cover it.
 *
 * Source: @iconify-json/flag (Flag Icons by Panayiotis Lipiridis, MIT), a
 * devDependency — nothing here is needed to build the theme, only to regenerate.
 *
 * Usage: node scripts/make-flags.mjs
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/assets/flags");

/* ---- Inputs -------------------------------------------------------- */

const iconsPath = join(root, "node_modules/@iconify-json/flag/icons.json");
let set;
try {
  set = JSON.parse(readFileSync(iconsPath, "utf8"));
} catch {
  console.error(
    "Cannot read @iconify-json/flag — install devDependencies first (`pnpm install`).",
  );
  process.exit(1);
}

// Parse the generated geo table rather than importing it: this is a plain node
// script and geo.ts is TypeScript.
const geo = readFileSync(join(root, "src/assets/geo.ts"), "utf8");
const codes = [...geo.matchAll(/^ {2}([A-Z]{2}): \[/gm)].map((m) => m[1]);
if (codes.length < 100) {
  console.error(`Only ${codes.length} codes parsed out of geo.ts — the format changed.`);
  process.exit(1);
}

/* ---- Emit ---------------------------------------------------------- */

/** Iconify stores bodies, not documents; `aliases` point one name at another. */
function resolve(name) {
  const alias = set.aliases?.[name];
  const icon = set.icons[alias ? alias.parent : name];
  if (!icon) return null;
  return {
    body: icon.body,
    width: icon.width ?? set.width ?? 16,
    height: icon.height ?? set.height ?? 16,
  };
}

mkdirSync(outDir, { recursive: true });

const written = new Set();
const missing = [];
let bytes = 0;

for (const code of codes) {
  // 4:3 rather than 1:1. The marker sits beside a two-letter code at label size
  // and a rectangle reads as a flag there; a square reads as an icon.
  const icon = resolve(`${code.toLowerCase()}-4x3`);
  if (!icon) {
    missing.push(code);
    continue;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}">` +
    `${icon.body}</svg>\n`;
  const file = `${code.toLowerCase()}.svg`;
  writeFileSync(join(outDir, file), svg);
  written.add(file);
  bytes += svg.length;
}

if (missing.length > 0) {
  console.error(
    `No flag in the icon set for: ${missing.join(", ")}.\n` +
      "Every code in COUNTRY_LATLNG must have one, or RegionTag renders a broken image.",
  );
  process.exit(1);
}

// A country dropped from geo.ts must not leave its flag behind to be shipped.
let removed = 0;
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".svg") && !written.has(file)) {
    rmSync(join(outDir, file));
    removed++;
  }
}

console.log(
  `✓ ${written.size} flags -> src/assets/flags (${(bytes / 1024).toFixed(0)} KB` +
    `${removed ? `, ${removed} stale removed` : ""})`,
);
