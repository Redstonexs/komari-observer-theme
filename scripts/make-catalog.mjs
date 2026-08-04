#!/usr/bin/env node
/**
 * Generates v1.json — a Komari **theme market source**.
 *
 * Komari's admin panel can register extra market sources alongside the official
 * one (Settings → Themes → Market → Sources). A source is just a JSON catalog
 * served over public HTTP(S); pointing an instance at this repo's v1.json lets
 * it discover Observer, see when a newer version exists, and install it without
 * anyone building or uploading a ZIP by hand.
 *
 * The contract is enforced server-side in web/api/admin/theme_market.go, and the
 * failure modes are unhelpfully quiet, so this script exists to make them
 * impossible rather than to be convenient:
 *
 *   - `name`, `short`, `version` and `author` are required; each of `name`,
 *     `description` and `author` may be a plain string or an i18n object.
 *   - `url`, `preview` and `download` must be ABSOLUTE http(s) URLs. Relative
 *     paths are rejected outright, and a host that resolves to a private
 *     address is refused at download time.
 *   - `download` and `sha256` must be present together or absent together.
 *   - On install the server re-hashes the ZIP and compares it to `sha256`, then
 *     reads the manifest inside and requires BOTH `short` and `version` to match
 *     the catalog entry. A catalog whose version has drifted from the packaged
 *     manifest installs nothing and reports only "does not match".
 *   - Catalogs are cached for 10 minutes, so a fresh publish is not visible
 *     instantly unless the admin hits refresh.
 *
 * Usage:
 *   node scripts/make-catalog.mjs                     # hash the local ZIP
 *   node scripts/make-catalog.mjs --sha256=<64 hex>   # CI: hash already known
 *   node scripts/make-catalog.mjs --source-only       # listed, not installable
 *   node scripts/make-catalog.mjs --out=/tmp/v1.json
 *   node scripts/make-catalog.mjs --check             # validate, write nothing
 *   node scripts/make-catalog.mjs --check --offline   # skip the download probe
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const root = process.cwd();
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const ZIP_NAME = "komari-theme-observer.zip";
const OUT = args.get("out") ?? join(root, "v1.json");
const CHECK = args.has("check");
const OFFLINE = args.has("offline");
/**
 * Emits an entry with no `download`/`sha256`. The market treats that as a
 * source-only listing: visible, with install disabled. It is the honest state
 * for a repo that has no release yet — the alternative is advertising a URL that
 * 404s, which is what a hand-committed catalog produces.
 */
const SOURCE_ONLY = args.has("source-only");

/**
 * Translated descriptions. The English text is taken from the manifest so there
 * is exactly one source of truth for it; the rest live here because the manifest
 * schema has no room for them.
 */
const DESCRIPTIONS = {
  "zh-CN":
    "面向 Komari Monitor 的极简未来感 HUD 主题。深空配色、仪表级字体、GSAP 动效、自定义背景，" +
    "并在连接不稳定时自动逐级降级传输通道。",
  "zh-TW":
    "為 Komari Monitor 打造的極簡未來感 HUD 主題。深空配色、儀表級字體、GSAP 動效、自訂背景，" +
    "並在連線不穩定時自動逐級降級傳輸通道。",
  ja:
    "Komari Monitor 向けのミニマルで近未来的な HUD テーマ。深宇宙のパレット、計器フォント、GSAP アニメーション、" +
    "カスタム背景に加え、接続が不安定になると転送方式を自動的に切り替えます。",
};

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

/* ---- manifest is the source of truth ------------------------------- */

const manifestPath = join(root, "komari-theme.json");
if (!existsSync(manifestPath)) fail("komari-theme.json not found — run from the repo root.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

for (const field of ["name", "short", "version", "author", "url"]) {
  if (!String(manifest[field] ?? "").trim()) {
    fail(`komari-theme.json is missing "${field}", which the market requires.`);
  }
}

/**
 * Repo slug comes from the manifest URL rather than a constant, so a fork only
 * has to change one field to publish its own source.
 */
const repo = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(manifest.url.trim());
if (!repo) {
  fail(`komari-theme.json "url" must be a GitHub repository URL, got: ${manifest.url}`);
}
const [, owner, name] = repo;
const slug = `${owner}/${name.replace(/\.git$/, "")}`;

/* ---- checksum ------------------------------------------------------ */

/**
 * Reads one entry out of a ZIP without a dependency.
 *
 * Deliberately minimal — it only has to read archives this repo produced, so
 * zip64, encryption and multi-disk archives are out of scope.
 */
function readZipEntry(buffer, wanted) {
  // The end-of-central-directory record is last, but a trailing comment can push
  // it up to 64 KiB from the end, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);

    if (name === wanted) {
      // Local header field lengths can differ from the central directory's, so
      // they must be re-read here rather than reused.
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buffer.subarray(start, start + compressedSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

let sha256 = SOURCE_ONLY
  ? ""
  : (args.get("sha256") ?? "").trim().replace(/^sha256:/i, "").toLowerCase();

if (!sha256 && !CHECK && !SOURCE_ONLY) {
  const zipPath = join(root, ZIP_NAME);
  if (!existsSync(zipPath)) {
    fail(
      `${ZIP_NAME} not found. Run \`pnpm package\` first, or pass --sha256=<hex> ` +
        `when the release artifact was built elsewhere.`,
    );
  }
  const zip = readFileSync(zipPath);
  sha256 = createHash("sha256").update(zip).digest("hex");

  // The one drift that gets past every other check: bumping the manifest and
  // regenerating the catalog WITHOUT repackaging. The digest would then describe
  // a ZIP whose manifest says something else, and the server aborts the install
  // with only "Theme manifest does not match the market catalog" — on someone
  // else's machine, days later.
  const packed = readZipEntry(zip, "komari-theme.json");
  if (!packed) {
    fail(`${ZIP_NAME} has no komari-theme.json at its root — Komari cannot install it.`);
  }
  const packedManifest = JSON.parse(packed.toString("utf8"));
  if (packedManifest.short !== manifest.short || packedManifest.version !== manifest.version) {
    fail(
      `${ZIP_NAME} is stale: it packages ${packedManifest.short}@${packedManifest.version}, ` +
        `but komari-theme.json now says ${manifest.short}@${manifest.version}. ` +
        `Run \`pnpm package\` again.`,
    );
  }
}

if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
  fail("sha256 must be exactly 64 lowercase hexadecimal characters.");
}

/* ---- entry --------------------------------------------------------- */

// Pinned to the release tag, not to a "latest" alias: an instance that installs
// from an older catalog snapshot must still receive the bytes that checksum
// matched, otherwise every historical entry silently breaks on the next release.
const tag = `v${manifest.version}`;
const entry = {
  name: manifest.name,
  short: manifest.short,
  description: {
    en: manifest.description,
    ...DESCRIPTIONS,
  },
  version: manifest.version,
  author: manifest.author,
  url: `https://github.com/${slug}`,
  // The default branch, so the card art tracks the repo rather than going stale
  // at whatever the first release looked like.
  preview: `https://raw.githubusercontent.com/${slug}/refs/heads/main/preview.png`,
  ...(sha256
    ? {
        download: `https://github.com/${slug}/releases/download/${tag}/${ZIP_NAME}`,
        sha256,
      }
    : {}),
};

/* ---- validate exactly the way the server does ----------------------- */

const problems = [];

const isText = (value) =>
  typeof value === "string"
    ? value.trim() !== ""
    : value && typeof value === "object"
      ? Object.values(value).some((v) => typeof v === "string" && v.trim() !== "")
      : false;

const isAbsoluteHttp = (value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
  } catch {
    return false;
  }
};

const validate = (theme) => {
  if (!isText(theme.name)) problems.push(`${theme.short}: name is empty`);
  if (!isText(theme.author)) problems.push(`${theme.short}: author is empty`);
  if (!theme.version) problems.push(`${theme.short}: version is empty`);
  // Same character class the server enforces on the manifest's short.
  if (!/^[A-Za-z0-9_-]+$/.test(theme.short ?? "")) {
    problems.push(`${theme.short}: short may only contain letters, digits, _ and -`);
  }
  if (theme.short === "default") problems.push("short must not be \"default\" — that is reserved");
  for (const field of ["url", "preview", "download"]) {
    const value = theme[field];
    if (!value && field !== "url") continue;
    if (!isAbsoluteHttp(value)) problems.push(`${theme.short}: ${field} is not an absolute http(s) URL`);
  }
  if (Boolean(theme.download) !== Boolean(theme.sha256)) {
    problems.push(`${theme.short}: download and sha256 must be provided together`);
  }
  if (theme.sha256 && !/^[0-9a-f]{64}$/.test(theme.sha256)) {
    problems.push(`${theme.short}: sha256 must be 64 lowercase hex characters`);
  }
};

/**
 * Fetches every advertised package and re-hashes it, exactly as the server does
 * on install.
 *
 * Structural validation cannot catch the failure that actually reaches users: a
 * catalog whose `download` points at a release that was never cut. It parses
 * perfectly and then 404s on someone else's machine with "Failed to download
 * theme: HTTP status 404". Committing v1.json ahead of the release is the easy
 * way to get there, so main is checked against reality on every push.
 *
 * A network that is simply unreachable warns instead of failing — an offline
 * developer should not be blocked. A definitive HTTP error is a real failure.
 */
async function probeDownloads(themes) {
  for (const theme of themes) {
    if (!theme.download) continue;
    let response;
    try {
      response = await fetch(theme.download, { redirect: "follow" });
    } catch (error) {
      console.warn(
        `  warn  ${theme.short}: could not reach ${theme.download} (${error.message}). ` +
          "Skipping the download probe.",
      );
      continue;
    }
    if (!response.ok) {
      const hint =
        response.status === 404
          ? ` — nothing published there. Cut the v${theme.version} release, or run ` +
            "`pnpm catalog --source-only` until you do."
          : "";
      problems.push(`${theme.short}: download returned HTTP ${response.status}${hint}`);
      continue;
    }
    const digest = createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex");
    if (digest !== theme.sha256) {
      problems.push(
        `${theme.short}: the published package hashes to ${digest}, but the catalog ` +
          `claims ${theme.sha256}. Every install would be refused.`,
      );
    }
  }
}

/* ---- merge with whatever is already published ----------------------- */

let previous = null;
if (existsSync(OUT)) {
  try {
    previous = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    if (CHECK) fail(`${OUT} is not valid JSON.`);
    console.warn(`  warn  ${OUT} is not valid JSON; regenerating from scratch.`);
  }
}

if (CHECK) {
  if (!previous) fail(`${OUT} does not exist — run \`pnpm catalog\` and commit it.`);
  const themes = Array.isArray(previous.themes) ? previous.themes : [];
  if (themes.length === 0) fail(`${OUT} has no themes.`);
  themes.forEach(validate);
  const shorts = themes.map((t) => String(t.short ?? "").toLowerCase());
  if (new Set(shorts).size !== shorts.length) problems.push("duplicate short values");
  if ([...shorts].sort().join(" ") !== shorts.join(" ")) {
    problems.push("themes must be sorted by short, case-insensitively");
  }
  if (!OFFLINE) await probeDownloads(themes);
  if (problems.length) {
    console.error(`\n✗ ${OUT} is not a valid theme market source:\n`);
    for (const p of problems) console.error(`  fail  ${p}`);
    process.exit(1);
  }
  const installable = themes.filter((t) => t.download).length;
  console.log(
    `✓ ${OUT} is a valid theme market source (${themes.length} theme(s), ` +
      `${installable} installable${OFFLINE ? "; download probe skipped" : ""})`,
  );
  process.exit(0);
}

validate(entry);
if (problems.length) {
  console.error("\n✗ Refusing to write an invalid catalog:\n");
  for (const p of problems) console.error(`  fail  ${p}`);
  process.exit(1);
}

// A source may legitimately list more than one theme; preserve any entry that
// is not ours instead of clobbering it.
const others = Array.isArray(previous?.themes)
  ? previous.themes.filter((t) => t?.short !== entry.short)
  : [];
const themes = [...others, entry].sort((a, b) =>
  String(a.short).toLowerCase().localeCompare(String(b.short).toLowerCase()),
);

const sameAsPublished =
  previous && JSON.stringify(previous.themes) === JSON.stringify(themes);

const catalog = {
  schema: 1,
  // Only re-stamped when something actually changed, so re-running the generator
  // does not manufacture a diff.
  updated_at: sameAsPublished ? previous.updated_at : new Date().toISOString(),
  themes,
};

writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");

console.log(`✓ ${OUT}`);
console.log(`  ${entry.short} ${entry.version}${sha256 ? "" : "  (source-only — no package)"}`);
if (sha256) {
  console.log(`  ${entry.download}`);
  console.log(`  sha256 ${sha256}`);
}
if (sameAsPublished) console.log("  unchanged since the last publish");
