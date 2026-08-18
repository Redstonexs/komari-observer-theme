#!/usr/bin/env node
/**
 * A dependency-free mock of Komari's public API, for developing this theme
 * without a real server.
 *
 * It reproduces the behaviours that actually shape the client, including the
 * awkward ones:
 *   - /api/clients is a WebSocket that only answers "get" / "get <uuid>",
 *     never pushes, and blanks each report's uuid
 *   - CPU usage is floored at 0.01
 *   - online-ness lives in a separate array, not in the report map
 *   - /api/rpc2 speaks JSON-RPC over both WebSocket (GET) and HTTP (POST)
 *   - the WS and RPC channels return DIFFERENT shapes for the same data
 *   - ping values are milliseconds, and NEGATIVE means packet loss
 *   - /api/records/load rejects load_type=gpu with HTTP 400
 *   - /api/records/load returns a DIFFERENT sample cadence per range: every
 *     few minutes for a day, roughly hourly for a week
 *
 * Usage:
 *   node scripts/mock-server.mjs [--port 25774] [--nodes 12] [--break tier,...]
 *
 * --break makes a tier fail so the fallback ladder can be exercised, e.g.
 *   node scripts/mock-server.mjs --break rpc2-ws
 *   node scripts/mock-server.mjs --break rpc2-ws,clients-ws
 *   node scripts/mock-server.mjs --break rpc2-ws,rpc2-http   # forces tier 5
 *
 * --flaky drops the browser sockets every ~12s to exercise reconnect/backoff.
 *
 * --login answers /api/me as a signed-in operator instead of a guest.
 */

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

/* ---- args --------------------------------------------------------- */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg("port", 25774));
const NODE_COUNT = Number(arg("nodes", 12));
const BROKEN = new Set(String(arg("break", "")).split(",").filter(Boolean));
const FLAKY = args.includes("--flaky");
const LOGGED_IN = args.includes("--login");

/* ---- fixture fleet ------------------------------------------------ */

// Region is free text. Operators type an ISO code, a non-ISO spelling, a flag
// emoji pasted from elsewhere, or a place name that is no country at all — the
// fixture carries all four so the client is never written against just one.
const REGIONS = ["JP", "DE", "🇸🇬", "US", "UK", "AU", "FR", "🇨🇦", "NL", "KR", "BR", "bengaluru"];
const OS = ["Debian 12", "Ubuntu 24.04", "Alpine 3.20", "Rocky 9", "Arch"];
const CITIES = ["tokyo", "fra", "sgp", "nyc", "lon", "syd", "par", "yyz", "ams", "icn", "gru", "bom"];

const GiB = 1024 ** 3;

const nodes = Array.from({ length: NODE_COUNT }, (_, i) => {
  const cores = [2, 4, 8, 16][i % 4];
  return {
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `${CITIES[i % CITIES.length]}-${String(i + 1).padStart(2, "0")}`,
    cpu_name: ["AMD EPYC 7003", "Intel Xeon E5-2680", "Ampere Altra", "AMD Ryzen 9 5950X"][i % 4],
    virtualization: ["kvm", "lxc", "none"][i % 3],
    arch: i % 5 === 0 ? "arm64" : "x86_64",
    cpu_cores: cores,
    cpu_physical_cores: cores / 2 || 1,
    os: OS[i % OS.length],
    kernel_version: "6.8.0-40-generic",
    gpu_name: i % 6 === 0 ? "NVIDIA RTX A4000" : "",
    region: REGIONS[i % REGIONS.length],
    mem_total: [4, 8, 16, 32][i % 4] * GiB,
    swap_total: 2 * GiB,
    disk_total: [40, 80, 160, 320][i % 4] * GiB,
    weight: NODE_COUNT - i,
    price: [0, 5, 12, 40][i % 4],
    billing_cycle: 30,
    auto_renewal: i % 2 === 0,
    currency: "$",
    expired_at: i % 4 === 0 ? new Date(Date.now() + (i - 1) * 86400000).toISOString() : null,
    group: ["edge", "core", "storage"][i % 3],
    tags: i % 3 === 0 ? "prod;web" : i % 3 === 1 ? "staging" : "",
    hidden: false,
    traffic_limit: i % 3 === 0 ? 1024 * GiB : 0,
    traffic_limit_type: "max",
    public_remark: i === 0 ? "Primary ingress" : "",
    created_at: new Date(Date.now() - 90 * 86400000).toISOString(),
    updated_at: new Date().toISOString(),
  };
});

// Deterministic-ish wander so the UI has something to animate.
const state = nodes.map((node, i) => ({
  cpu: 10 + ((i * 7) % 60),
  ram: node.mem_total * (0.2 + ((i * 11) % 50) / 100),
  disk: node.disk_total * (0.15 + ((i * 13) % 60) / 100),
  netIn: 200_000 + i * 40_000,
  netOut: 120_000 + i * 25_000,
  totalUp: 40 * GiB + i * GiB,
  totalDown: 90 * GiB + i * GiB,
  uptime: 3600 * (24 * (i + 3) + i),
  // One node stays offline so the offline styling is always visible.
  online: i !== 3,
}));

const started = Date.now();

setInterval(() => {
  const t = (Date.now() - started) / 1000;
  state.forEach((s, i) => {
    if (!s.online) return;
    const wave = Math.sin(t / (6 + (i % 5)) + i) * 18;
    s.cpu = Math.max(0, Math.min(100, 34 + wave + Math.sin(t * 1.7 + i) * 6));
    s.ram = Math.max(0, Math.min(nodes[i].mem_total, s.ram + Math.sin(t / 9 + i) * 6_000_000));
    s.netIn = Math.max(0, 400_000 + Math.sin(t / 3 + i) * 350_000);
    s.netOut = Math.max(0, 260_000 + Math.cos(t / 4 + i) * 200_000);
    s.totalUp += s.netOut;
    s.totalDown += s.netIn;
    s.uptime += 1;
  });
}, 1000);

/* ---- report shapes ------------------------------------------------ */

/** Nested protocol/v1.Report, as the legacy WebSocket emits it. */
function v1Report(i) {
  const node = nodes[i];
  const s = state[i];
  return {
    // uuid deliberately blank — the real server strips it.
    cpu: { name: node.cpu_name, cores: node.cpu_cores, arch: node.arch, usage: s.cpu || 0.01 },
    ram: { total: node.mem_total, used: Math.round(s.ram) },
    swap: { total: node.swap_total, used: Math.round(node.swap_total * 0.1) },
    load: { load1: +(s.cpu / 25).toFixed(2), load5: +(s.cpu / 30).toFixed(2), load15: +(s.cpu / 40).toFixed(2) },
    disk: { total: node.disk_total, used: Math.round(s.disk) },
    network: {
      up: Math.round(s.netOut),
      down: Math.round(s.netIn),
      totalUp: Math.round(s.totalUp),
      totalDown: Math.round(s.totalDown),
    },
    connections: { tcp: 40 + (i % 30), udp: 5 + (i % 8) },
    ...(node.gpu_name
      ? {
          gpu: {
            count: 1,
            average_usage: Math.abs(Math.sin(Date.now() / 5000 + i)) * 80,
            detailed_info: [
              {
                name: node.gpu_name,
                memory_total: 16 * GiB,
                memory_used: 6 * GiB,
                utilization: Math.abs(Math.sin(Date.now() / 5000 + i)) * 80,
                temperature: 54 + (i % 12),
              },
            ],
          },
        }
      : {}),
    uptime: Math.round(s.uptime),
    process: 120 + (i % 60),
    message: "",
    updated_at: new Date().toISOString(),
  };
}

/** Flat recordLike, as rpc2 common:getNodesLatestStatus emits it. */
function recordLike(i) {
  const node = nodes[i];
  const s = state[i];
  return {
    client: node.uuid,
    time: new Date().toISOString(),
    cpu: s.online ? s.cpu || 0.01 : 0,
    gpu: node.gpu_name ? Math.abs(Math.sin(Date.now() / 5000 + i)) * 80 : 0,
    ram: s.online ? Math.round(s.ram) : 0,
    ram_total: node.mem_total,
    swap: Math.round(node.swap_total * 0.1),
    swap_total: node.swap_total,
    load: +(s.cpu / 25).toFixed(2),
    load5: +(s.cpu / 30).toFixed(2),
    load15: +(s.cpu / 40).toFixed(2),
    temp: 38 + (i % 20),
    disk: Math.round(s.disk),
    disk_total: node.disk_total,
    net_in: s.online ? Math.round(s.netIn) : 0,
    net_out: s.online ? Math.round(s.netOut) : 0,
    net_total_up: Math.round(s.totalUp),
    net_total_down: Math.round(s.totalDown),
    process: 120 + (i % 60),
    connections: 40 + (i % 30),
    connections_udp: 5 + (i % 8),
    online: s.online,
    uptime: Math.round(s.uptime),
    ping: {
      1: { name: "HTTP check", latest: 20 + (i % 40), avg: 25 + (i % 30), tail: 0.2, loss: i % 7 === 0 ? 8 : 0, min: 12, max: 90 },
    },
  };
}

function latestStatusMap() {
  const out = {};
  nodes.forEach((node, i) => {
    out[node.uuid] = recordLike(i);
  });
  return out;
}

/* ---- history ------------------------------------------------------ */

/**
 * Sample spacing by range, in minutes.
 *
 * The detail that matters most to the availability strip: the cadence is NOT
 * constant. A one-day window comes back every few minutes while a one-week
 * window comes back roughly hourly, so any client that assumes one fixed
 * spacing — or that reuses one window's records at another window's
 * resolution — paints the hourly data as alternating up/down.
 */
function cadenceMinutes(hours) {
  if (hours <= 24) return 3;
  if (hours <= 72) return 30;
  return 60;
}

/**
 * Scripted downtime, as [node index, hours ago it started, length in hours].
 *
 * Records simply stop for the duration — which is all a real outage looks like
 * from the outside, and the only thing availability can be inferred from.
 * Node 1's is deliberately shorter than the weekly sampling interval, so it is
 * visible at 1 day and genuinely invisible at 7.
 */
const OUTAGES = [
  [0, 9, 3],
  // Deliberately off the hour: a real outage does not respect block boundaries,
  // and blocks it only partly covers have to render as partly down.
  [0, 16.2, 0.7],
  [0, 30, 0.5],
  [1, 2, 0.35],
  [3, 50, 6],
];

/** Nodes registered recently: a longer window has nothing to show before this,
 *  which must read as "unknown" rather than as days of downtime. */
const FIRST_SEEN_HOURS = { 2: 48 };

function loadRecords(uuid, hours) {
  const i = nodes.findIndex((n) => n.uuid === uuid);
  if (i < 0) return [];
  const node = nodes[i];

  const now = Date.now();
  const step = cadenceMinutes(hours) * 60_000;
  const start = now - hours * 3600_000;
  const firstSeen = now - (FIRST_SEEN_HOURS[i] ?? Infinity) * 3600_000;
  const outages = OUTAGES.filter(([n]) => n === i).map(([, ago, length]) => [
    now - ago * 3600_000,
    now - (ago - length) * 3600_000,
  ]);

  const out = [];
  for (let t = start; t <= now; t += step) {
    if (t < firstSeen) continue;
    if (outages.some(([from, to]) => t >= from && t < to)) continue;

    const k = out.length;
    const phase = t / 600_000 + i;
    out.push({
      client: uuid,
      time: new Date(t).toISOString(),
      cpu: +(38 + Math.sin(phase) * 22 + Math.sin(phase * 3.3) * 7).toFixed(2),
      gpu: 0,
      ram: Math.round(node.mem_total * (0.45 + Math.sin(phase / 2) * 0.15)),
      // The real server rebuilds history from per-metric series and stores no
      // capacity or temperature metric, so these columns come back zeroed.
      // Mirror that: a mock that invents totals hides charts that divide by them.
      ram_total: 0,
      swap: Math.round(node.swap_total * 0.1),
      swap_total: 0,
      load: +(1.2 + Math.sin(phase) * 0.8).toFixed(2),
      temp: 0,
      disk: Math.round(node.disk_total * 0.42),
      disk_total: 0,
      net_in: Math.round(500_000 + Math.sin(phase * 1.4) * 400_000),
      net_out: Math.round(320_000 + Math.cos(phase * 1.1) * 260_000),
      net_total_up: Math.round(40 * GiB + k * 1_000_000),
      net_total_down: Math.round(90 * GiB + k * 2_000_000),
      traffic_up: 0,
      traffic_down: 0,
      process: 130 + (k % 40),
      connections: 50 + (k % 25),
      connections_udp: 6,
    });
  }
  return out;
}

/** Probe definitions, shared by /api/task/ping and the record generator. */
const PING_TASKS = [
  { id: 1, weight: 10, name: "HTTP check", default_on: true, type: "http", interval: 60, base: 18 },
  { id: 2, weight: 5, name: "ICMP", default_on: false, type: "icmp", interval: 30, base: 9 },
];
/** Probes only cover part of the fleet, so "no probe covers this node" is testable. */
const pingClients = () => nodes.slice(0, 5).map((n) => n.uuid);

/**
 * Ping history.
 *
 * Both filters are honoured because the theme uses BOTH shapes: the per-node
 * health block queries by uuid alone and expects one series per covering task,
 * while the comparison page queries by task_id and expects one series per node.
 * An earlier version ignored uuid, which made every node look identical.
 *
 * Point density matches the real server, which caps a ping query at 4000 points
 * per task rather than the 500 that load records get.
 */
function pingRecords({ taskId, uuid, hours }) {
  const clients = pingClients();
  const targets = uuid ? clients.filter((c) => c === uuid) : clients;
  const tasks = taskId ? PING_TASKS.filter((t) => t.id === taskId) : PING_TASKS;
  if (targets.length === 0 || tasks.length === 0) return [];

  const span = hours * 3600_000;
  const now = Date.now();
  const out = [];

  for (const task of tasks) {
    // One sample per probe interval, clamped the way the server clamps it.
    const count = Math.min(4000, Math.max(2, Math.round(span / (task.interval * 1000))));
    const step = span / count;
    for (const client of targets) {
      const i = clients.indexOf(client);
      for (let k = 0; k < count; k++) {
        const t = now - span + k * step;
        const lost = (k + i * 13 + task.id * 7) % 47 === 0;
        out.push({
          client,
          task_id: task.id,
          time: new Date(t).toISOString(),
          value: lost
            ? -1
            : Math.round(task.base + i * 14 + Math.sin(k / 9 + i) * 9 + Math.sin(k / 2.3) * 3),
        });
      }
    }
  }
  return out;
}

/* ---- minimal RFC 6455 WebSocket ----------------------------------- */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(payload) {
  const data = Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/** Handles one client->server frame; returns {opcode, text, rest} or null. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, text: payload.toString("utf8"), rest: buf.subarray(offset + len) };
}

function upgrade(req, socket, onMessage) {
  const key = req.headers["sec-websocket-key"];
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );

  const send = (obj) => {
    if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(obj)));
  };

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const frame = decodeFrame(pending);
      if (!frame) break;
      pending = frame.rest;
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x1) onMessage(frame.text, send);
    }
  });
  socket.on("error", () => socket.destroy());

  if (FLAKY) {
    // Drop the connection periodically so reconnect/backoff gets exercised.
    setTimeout(() => socket.destroy(), 12_000 + Math.random() * 6_000);
  }
  return send;
}

/* ---- HTTP --------------------------------------------------------- */

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const ok = (data, message = "") => ({ status: "success", message, data });
const err = (message) => ({ status: "error", message });

function rpcDispatch(method, params) {
  switch (method) {
    case "rpc.ping":
      return { pong: true };
    case "common:getNodesLatestStatus": {
      const all = latestStatusMap();
      if (params?.uuid) return { [params.uuid]: all[params.uuid] };
      if (Array.isArray(params?.uuids)) {
        const subset = {};
        for (const id of params.uuids) if (all[id]) subset[id] = all[id];
        return subset;
      }
      return all;
    }
    case "common:getNodes": {
      const map = {};
      for (const node of nodes) map[node.uuid] = node;
      return map;
    }
    case "common:getVersion":
      return { version: "1.3.2-mock", hash: "mock" };
    default:
      return { __rpcError: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (path === "/api/public") {
    return json(
      res,
      ok({
        sitename: "Observer Mock",
        description: "A simple server monitor tool.",
        custom_head: "",
        custom_body: "",
        oauth_enable: false,
        oauth_provider: "github",
        disable_password_login: false,
        cors_origin_check_enabled: false,
        record_enabled: true,
        record_preserve_time: 720,
        ping_record_preserve_time: 720,
        private_site: false,
        visitor_audit_enabled: false,
        theme: "observer",
        // Left empty on purpose: the theme must supply its own defaults, since
        // the real server only merges them for an installed managed theme.
        theme_settings: {},
      }),
    );
  }

  // Bare object, no envelope — matches WithRaw() on the real endpoint.
  if (path === "/api/me") {
    return json(
      res,
      LOGGED_IN
        ? { username: "operator", logged_in: true, uuid: randomUUID() }
        : { username: "Guest", logged_in: false },
    );
  }

  if (path === "/api/version") return json(res, ok({ version: "1.3.2-mock", hash: "mock" }));

  if (path === "/api/nodes") return json(res, ok(nodes));

  if (path.startsWith("/api/recent/")) {
    if (BROKEN.has("recent-http")) return json(res, err("mock: recent-http disabled"), 500);
    const uuid = decodeURIComponent(path.slice("/api/recent/".length));
    const i = nodes.findIndex((n) => n.uuid === uuid);
    if (i < 0) return json(res, ok([]));
    return json(res, ok([v1Report(i)]));
  }

  if (path === "/api/records/load") {
    const uuid = url.searchParams.get("uuid");
    const loadType = url.searchParams.get("load_type");
    if (!uuid) return json(res, err("UUID is required"), 400);
    // Faithfully reproduces the server-side allowlist bug.
    if (loadType === "gpu") return json(res, err("Invalid load_type parameter"), 400);
    const hours = Number(url.searchParams.get("hours") ?? 4) || 4;
    const records = loadRecords(uuid, hours);
    return json(res, ok({ records, count: records.length, has_gpu_data: false }));
  }

  if (path === "/api/records/ping") {
    const hours = Number(url.searchParams.get("hours") ?? 4) || 4;
    const taskId = Number(url.searchParams.get("task_id") ?? 0) || 0;
    const uuid = url.searchParams.get("uuid") ?? "";
    const records = pingRecords({ taskId, uuid, hours });
    return json(res, ok({ count: records.length, records }));
  }

  if (path === "/api/task/ping") {
    const clients = pingClients();
    return json(
      res,
      ok(
        PING_TASKS.map(({ id, weight, name, default_on, type, interval }) => ({
          id,
          weight,
          name,
          clients,
          default_on,
          type,
          interval,
        })),
      ),
    );
  }

  if (path === "/api/rpc2" && req.method === "POST") {
    if (BROKEN.has("rpc2-http")) {
      res.writeHead(503).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        return json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const result = rpcDispatch(request.method, request.params);
      if (result?.__rpcError) {
        return json(res, { jsonrpc: "2.0", id: request.id, error: result.__rpcError });
      }
      return json(res, { jsonrpc: "2.0", id: request.id, result });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/clients") {
    if (BROKEN.has("clients-ws")) return socket.destroy();
    upgrade(req, socket, (message, send) => {
      // Only "get" and "get <uuid>" are understood; anything else is an error
      // frame and the connection stays open.
      if (message !== "get" && !message.startsWith("get ")) {
        return send({ status: "error", error: "Invalid message" });
      }
      const only = message.startsWith("get ") ? message.slice(4).trim() : "";
      const online = [];
      const data = {};
      nodes.forEach((node, i) => {
        if (only && node.uuid !== only) return;
        if (state[i].online) online.push(node.uuid);
        data[node.uuid] = v1Report(i);
      });
      send({ status: "success", data: { online, data } });
    });
    return;
  }

  if (url.pathname === "/api/rpc2") {
    if (BROKEN.has("rpc2-ws")) return socket.destroy();
    upgrade(req, socket, (message, send) => {
      let request;
      try {
        request = JSON.parse(message);
      } catch {
        return;
      }
      const result = rpcDispatch(request.method, request.params);
      if (result?.__rpcError) {
        return send({ jsonrpc: "2.0", id: request.id, error: result.__rpcError });
      }
      send({ jsonrpc: "2.0", id: request.id, result });
    });
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Komari mock listening on http://127.0.0.1:${PORT}`);
  console.log(`  nodes:  ${NODE_COUNT} (one held offline)`);
  console.log(`  broken: ${BROKEN.size ? [...BROKEN].join(", ") : "none"}`);
  console.log(`  flaky:  ${FLAKY}`);
  void randomUUID;
});
