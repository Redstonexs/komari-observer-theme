#!/usr/bin/env node
/**
 * Minimal ZIP writer, so packaging does not depend on the `zip` binary being
 * installed (it is absent from plenty of dev machines and slim CI images).
 *
 * Deliberately produces the same archive shape as `zip -r`: directory entries
 * included, deflate compression, paths relative to the staging root. Timestamps
 * are fixed so the same input always produces byte-identical output — which
 * matters because the theme market records a SHA-256 of the release asset.
 *
 * Usage: node scripts/make-zip.mjs <output.zip> <sourceDir>
 */

import { deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [, , outFile, sourceDir] = process.argv;
if (!outFile || !sourceDir) {
  console.error("usage: make-zip.mjs <output.zip> <sourceDir>");
  process.exit(1);
}

/* ---- CRC32 -------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---- Walk --------------------------------------------------------- */

/** Sorted so archive order — and therefore the checksum — is deterministic. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join("/");
    if (statSync(full).isDirectory()) {
      out.push({ name: `${rel}/`, dir: true });
      walk(full, base, out);
    } else {
      out.push({ name: rel, dir: false, data: readFileSync(full) });
    }
  }
  return out;
}

/* ---- Write -------------------------------------------------------- */

// Fixed MS-DOS timestamp (1980-01-01) keeps the output reproducible.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const entries = walk(sourceDir);
const chunks = [];
const central = [];
let offset = 0;

for (const entry of entries) {
  const nameBuf = Buffer.from(entry.name, "utf8");
  const raw = entry.dir ? Buffer.alloc(0) : entry.data;
  // Store directories and anything deflate would inflate.
  const deflated = entry.dir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 9 });
  const useDeflate = !entry.dir && deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = entry.dir ? 0 : crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  chunks.push(local, nameBuf, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk number
  cd.writeUInt16LE(0, 36); // internal attrs
  // Unix mode in the high 16 bits: 0755 for directories, 0644 for files.
  cd.writeUInt32LE(entry.dir ? 0x41ed0010 : 0x81a40000, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...chunks, centralBuf, eocd]);
writeFileSync(outFile, zip);

console.log(`${outFile}  ${(zip.length / 1024).toFixed(1)} KB  ${entries.length} entries`);
for (const entry of entries) console.log(`  ${entry.name}`);
