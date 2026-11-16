// The lab's backend: two WebSocket services, both instrumented.
//
//   /ws/rows   request → response. The page sends {id, y0, y1, x0, x1} and
//              gets {id, y0, x0, rows, srv} back. The service models a query
//              engine: `serverMs` of service time per request (± jitterMs),
//              and `conc` requests served at once. With conc=1 it is a
//              single-server queue: requests that arrive while one is being
//              served wait in line, which is how congestion appears.
//              {cancel: id} removes a request that has not started.
//
//   /ws/ticks  a stream of cell updates the server pushes on its own clock:
//              `hz` messages a second, `n` cells each, over `span` rows.
//              conflate=MS keeps only the latest value per cell and sends one
//              message every MS milliseconds. wire=bin sends Float64 records
//              instead of JSON. The client can change the rate while running.
//
// Every receive, service interval and send is recorded in spans.mjs.

import { WebSocketServer } from "ws";
import { ROW_HEIGHT, columnKind, value, window_ } from "../pages/src/rows.js";
import { counter, instant, nowUs, span } from "./spans.mjs";

void ROW_HEIGHT;
const num = (q, k, d) => (q.has(k) && q.get(k) !== "" ? Number(q.get(k)) : d);

// A small seeded generator, so runs are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ── /ws/rows ────────────────────────────────────────────────────────────

function serveRows(ws, q) {
  const serverMs = num(q, "serverMs", 0);
  const jitterMs = num(q, "jitterMs", 0);
  const conc = num(q, "conc", Infinity) || Infinity;
  const rows = num(q, "rows", 100_000);
  const pad = num(q, "padBytes", 0); // extra payload per response, to study message size
  const random = rng(num(q, "seed", 1));
  const queue = []; // requests waiting for a free server
  let busy = 0;
  const conn = (serveRows.next = (serveRows.next ?? 0) + 1);

  const pump = () => {
    while (busy < conc && queue.length) start(queue.shift());
    counter(`rows queue (conn ${conn})`, queue.length);
  };
  const start = (req) => {
    busy++;
    const startUs = nowUs();
    const service = Math.max(0, serverMs + (jitterMs ? (random() * 2 - 1) * jitterMs : 0));
    const finish = () => {
      const t0 = nowUs();
      const body = window_(req.y0, req.y1, req.x0 ?? 0, req.x1 ?? 6, rows);
      const msg = { id: req.id, y0: req.y0, x0: req.x0 ?? 0, rows: body, srv: { recv: req.recvUs, start: startUs, done: t0 } };
      if (pad) msg.pad = "x".repeat(pad);
      const text = JSON.stringify(msg);
      const t1 = nowUs();
      span("query", `query #${req.id}`, startUs, t1 - startUs, { y0: req.y0, y1: req.y1, waitedMs: (startUs - req.recvUs) / 1000, serviceMs: service });
      span("query", `encode #${req.id}`, t0, t1 - t0, { bytes: text.length });
      ws.send(text);
      instant("io", `send #${req.id}`, t1, { bytes: text.length, buffered: ws.bufferedAmount });
      busy--;
      pump();
    };
    if (service > 0) setTimeout(finish, service);
    else finish();
  };

  ws.on("message", (data) => {
    const recvUs = nowUs();
    const req = JSON.parse(data.toString());
    if (req.cancel !== undefined) {
      const i = queue.findIndex((r) => r.id === req.cancel);
      if (i >= 0) {
        queue.splice(i, 1);
        instant("io", `cancelled #${req.cancel}`, recvUs);
        ws.send(JSON.stringify({ id: req.cancel, cancelled: true }));
      }
      counter(`rows queue (conn ${conn})`, queue.length);
      return;
    }
    req.recvUs = recvUs;
    instant("io", `recv #${req.id}`, recvUs, { y0: req.y0, y1: req.y1, queued: queue.length, busy });
    queue.push(req);
    pump();
  });
}

// ── /ws/ticks ───────────────────────────────────────────────────────────

function serveTicks(ws, q) {
  let hz = num(q, "hz", 10);
  const n = num(q, "n", 1); // cells per message
  const rowSpan = num(q, "span", 40); // rows that receive updates: 0..span-1
  const cols = num(q, "cols", 6);
  const conflate = num(q, "conflate", 0); // ms; 0 = send every update
  const bin = q.get("wire") === "bin";
  const dropAbove = num(q, "dropAbove", 0); // bytes buffered in the socket above which a send is skipped
  const random = rng(num(q, "seed", 7));
  const numeric = [];
  for (let c = 0; c < cols; c++) if (columnKind(c) === "price" || columnKind(c) === "qty") numeric.push(c);

  let seq = 0;
  let sent = 0;
  let skipped = 0;
  const epoch = nowUs();
  let produced = 0; // messages due so far are computed from elapsed time, so a late timer catches up
  let rateSince = epoch;
  let rateBase = 0;
  const dirty = new Map(); // conflation: cell key → [row, col, value]
  let oldest = 0;

  const makeUpdate = () => {
    const r = Math.floor(random() * rowSpan);
    const c = numeric[Math.floor(random() * numeric.length)];
    const base = value(r, c);
    const v = columnKind(c) === "price" ? Math.round((base + (random() - 0.5) * 20) * 100) / 100 : Math.floor(random() * 1000);
    return [r, c, v];
  };
  const send = (updates, t, first) => {
    if (dropAbove && ws.bufferedAmount > dropAbove) return void skipped++;
    const s = seq;
    let payload;
    if (bin) {
      const f = new Float64Array(3 + updates.length * 3);
      f[0] = s; f[1] = t; f[2] = first;
      updates.forEach(([r, c, v], i) => { f[3 + i * 3] = r; f[4 + i * 3] = c; f[5 + i * 3] = v; });
      payload = Buffer.from(f.buffer);
    } else payload = JSON.stringify({ s, t, f: first, u: updates });
    ws.send(payload);
    sent++;
    if (sent % 16 === 1) counter("ticks socket buffered bytes", ws.bufferedAmount);
  };
  const produce = () => {
    const now = nowUs();
    const due = rateBase + Math.floor(((now - rateSince) / 1e6) * hz);
    const t0 = now;
    let made = 0;
    while (produced < due) {
      produced++;
      seq++;
      made++;
      const updates = [];
      for (let i = 0; i < n; i++) updates.push(makeUpdate());
      if (conflate) {
        if (!dirty.size) oldest = now;
        for (const u of updates) dirty.set(u[0] * 4096 + u[1], u);
      } else send(updates, now, now);
    }
    if (made) span("ticks", conflate ? "produce (into conflation map)" : "produce + send", t0, nowUs() - t0, { messages: made, seq });
  };
  const flush = () => {
    if (!dirty.size) return;
    const t0 = nowUs();
    const updates = [...dirty.values()];
    dirty.clear();
    send(updates, t0, oldest);
    span("ticks", "conflated flush", t0, nowUs() - t0, { cells: updates.length, seq });
  };
  const timer = setInterval(produce, 1);
  const flusher = conflate ? setInterval(flush, conflate) : null;
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.hz !== undefined) {
      const now = nowUs();
      rateBase = produced;
      rateSince = now;
      hz = m.hz;
      instant("ticks", `rate → ${hz}/s`, now);
    }
    if (m.stats) ws.send(JSON.stringify({ stats: { seq, sent, skipped, buffered: ws.bufferedAmount } }));
  });
  ws.on("close", () => {
    clearInterval(timer);
    if (flusher) clearInterval(flusher);
  });
}

export function attachBackend(httpServer, { extra = {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const routes = { "/ws/rows": serveRows, "/ws/ticks": serveTicks, ...extra };
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const route = routes[url.pathname];
    if (!route) return; // Vite's HMR socket and anything else
    socket.setNoDelay(true);
    // A route is a handler on the shared server, or brings its own (other WebSocket options).
    if (typeof route === "function") wss.handleUpgrade(req, socket, head, (ws) => route(ws, url.searchParams));
    else route.wss.handleUpgrade(req, socket, head, (ws) => route.handle(ws, url.searchParams));
  });
}
