#!/usr/bin/env node
/**
 * Verifies a build against Komari's theme contract before it can be packaged.
 *
 * Every check here corresponds to a real failure mode that is SILENT at build
 * time and only shows up once the theme is installed on a live server, which is
 * exactly the kind of bug that ships.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const failures = [];
const warnings = [];

const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

/* ---- dist exists and is non-empty ------------------------------- */

if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  fail("dist/ does not exist — run `pnpm build` first.");
} else if (readdirSync(dist).length === 0) {
  fail("dist/ is empty.");
}

const indexPath = join(dist, "index.html");
if (!existsSync(indexPath)) {
  fail("dist/index.html is missing — Komari serves this file for every route.");
}

/* ---- index.html sentinels --------------------------------------- */

if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");

  // Assembled at runtime so this file can be grepped without matching itself,
  // and so the strings are never accidentally "fixed" by a formatter.
  const TITLE = `<title>${"Komari"} ${"Monitor"}</title>`;
  const DESCRIPTION = `A simple server ${"monitor"} tool.`;
  const LANG = `<html lang="${"en"}">`;

  if (!html.includes(TITLE)) {
    fail(`index.html is missing the exact title sentinel ${TITLE} — the operator's sitename will never be injected.`);
  }
  if (!html.includes(DESCRIPTION)) {
    fail(`index.html is missing the description sentinel "${DESCRIPTION}" — the operator's description will never be injected.`);
  }
  if (!html.includes(LANG)) {
    fail(`index.html is missing ${LANG} — the server cannot rewrite the language attribute.`);
  }

  // The server replaces the description at EVERY occurrence. Inside an HTML
  // comment that turns an operator's description into potential markup
  // injection if it contains a comment terminator.
  const commentBodies = html.match(/<!--[\s\S]*?-->/g) ?? [];
  for (const body of commentBodies) {
    if (body.includes(DESCRIPTION) || body.includes(TITLE)) {
      fail("An HTML comment in index.html contains a replacement sentinel. The server's global substring replace would inject operator-controlled text into the comment.");
      break;
    }
  }

  // A stray "-->" inside a comment closes it early and dumps the remainder of
  // the comment into the page as visible text. Easy to introduce when the
  // comment is *about* HTML comments, and invisible until you load the page.
  const opens = (html.match(/<!--/g) ?? []).length;
  const closes = (html.match(/-->/g) ?? []).length;
  if (opens !== closes) {
    fail(
      `index.html has ${opens} comment opener(s) but ${closes} closer(s) — a comment is terminating early and its remainder will render as page text.`,
    );
  }

  // The silent killer: Vite injects its script/stylesheet tags before the FIRST
  // closing head tag in the file. If a comment mentions that tag literally, the
  // whole application is injected INSIDE the comment — the page loads white,
  // with no console error anywhere. Checking against comment-stripped HTML is
  // the only way to catch it.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<script[^>]+type="module"/.test(stripped)) {
    fail(
      "The module script tag is missing or commented out in index.html. Vite injects it before the FIRST closing head tag — check that no comment contains that tag literally.",
    );
  }
  if (!/<link[^>]+rel="stylesheet"/.test(stripped)) {
    fail("The stylesheet link is missing or commented out in index.html (same cause as above).");
  }

  if (!html.includes('id="root"')) {
    fail("index.html has no #root mount point.");
  }

  // Attribution is a documented requirement of publishing a Komari theme. It is
  // rendered by React, so only warn — we cannot see it in the static HTML.
  if (!html.includes("Powered by Komari Monitor.")) {
    warn('"Powered by Komari Monitor." was not found in index.html (expected — it is rendered client-side). Confirm the footer still shows it.');
  }
}

/* ---- asset naming ------------------------------------------------ */

const assetsDir = join(dist, "assets");
if (existsSync(assetsDir)) {
  const offenders = readdirSync(assetsDir).filter((name) => name.startsWith("_"));
  if (offenders.length > 0) {
    fail(`Assets starting with "_" are ignored by Go's embed directive: ${offenders.join(", ")}`);
  }
}

/* ---- absolute asset paths ---------------------------------------- */

if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  // Komari maps request path P to <themeRoot>/dist/P, so relative asset URLs
  // break as soon as the user is on a nested route such as /node/<uuid>.
  if (/(src|href)="\.\//.test(html)) {
    fail('index.html references assets with a relative "./" path. Vite `base` must be "/".');
  }
}

/* ---- GSAP legal notices ------------------------------------------ */

if (existsSync(assetsDir)) {
  const js = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  const bundled = js.some((f) => readFileSync(join(assetsDir, f), "utf8").includes("gsap"));
  const hasNotice = js.some((f) => {
    const src = readFileSync(join(assetsDir, f), "utf8");
    return src.includes("GreenSock") || src.includes("@license");
  });
  if (bundled && !hasNotice) {
    fail("GSAP appears to be bundled but its license banner was stripped. The GSAP Standard License forbids removing proprietary notices — set esbuild.legalComments in vite.config.ts.");
  }
}

/* ---- manifest ---------------------------------------------------- */

const manifestPath = join(root, "komari-theme.json");
if (!existsSync(manifestPath)) {
  fail("komari-theme.json is missing from the repository root.");
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(`komari-theme.json is not valid JSON: ${err.message}`);
  }

  if (manifest) {
    if (!manifest.name) fail("komari-theme.json: `name` is required.");
    if (!manifest.short) fail("komari-theme.json: `short` is required.");
    if (manifest.short === "default") fail('komari-theme.json: `short` may not be "default".');
    if (manifest.short && !/^[A-Za-z0-9_-]+$/.test(manifest.short)) {
      fail("komari-theme.json: `short` may only contain letters, digits, underscore and hyphen — it is used as a directory name.");
    }
    // purcarte ships a "tags:VERSION" placeholder for CI to substitute; the
    // market validator rejects a manifest whose version disagrees with the tag.
    if (typeof manifest.version === "string" && /^tags?:/i.test(manifest.version)) {
      fail(`komari-theme.json: \`version\` is still the CI placeholder "${manifest.version}".`);
    }

    const config = manifest.configuration;
    if (config && config.type === "managed") {
      const items = Array.isArray(config.data) ? config.data : [];
      const seen = new Set();
      const VALID = new Set(["title", "string", "number", "select", "switch", "richtext"]);
      for (const item of items) {
        if (!VALID.has(item.type)) {
          fail(`komari-theme.json: unsupported configuration type "${item.type}".`);
        }
        if (item.type === "title") continue;
        if (!item.key) {
          fail(`komari-theme.json: a "${item.type}" item has no key.`);
          continue;
        }
        if (seen.has(item.key)) fail(`komari-theme.json: duplicate key "${item.key}".`);
        seen.add(item.key);
        if (item.type === "select") {
          if (typeof item.options !== "string" || !item.options.includes(",")) {
            fail(`komari-theme.json: select "${item.key}" needs comma-separated \`options\` (a string, not an array).`);
          } else if (item.default != null && !item.options.split(",").map((o) => o.trim()).includes(String(item.default))) {
            fail(`komari-theme.json: select "${item.key}" has a default that is not among its options.`);
          }
        }
      }

      // The theme reads these at runtime; a key present in one place but not
      // the other is a silent no-op setting.
      const settingsSrc = join(root, "src/config/settings.ts");
      if (existsSync(settingsSrc)) {
        const src = readFileSync(settingsSrc, "utf8");
        for (const key of seen) {
          if (!src.includes(key)) {
            warn(`Setting "${key}" is declared in komari-theme.json but never read in src/config/settings.ts.`);
          }
        }
      }
    }
  }
}

/* ---- preview ------------------------------------------------------ */

if (!existsSync(join(root, "preview.png"))) {
  fail("preview.png is missing — it is required in the theme package.");
}

/* ---- report ------------------------------------------------------- */

for (const w of warnings) console.warn(`  warn  ${w}`);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} problem(s) with the theme package:\n`);
  for (const f of failures) console.error(`  fail  ${f}`);
  console.error("");
  process.exit(1);
}

console.log(`✓ theme package verified${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
