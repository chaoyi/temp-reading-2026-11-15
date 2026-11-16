// Where cell values come from. Every panel reads through the same Source, so
// a difference between panels in a trace is the library's, not the data's.
//
//   local  values are computed in the page; get() resolves at once.
//   ws     values come from the backend over a WebSocket (/ws/rows). Cells
//          received are cached. How missing cells are requested is `policy`:
//            every     ask at once for every range not cached or in flight
//            inflight  one request at a time; while it is out, remember only
//                      the newest range wanted and ask for it when the reply
//                      lands (regular-table's own draw loop behaves this way)
//            cancel    like `every`, but tell the server to drop requests the
//                      viewport has left
//
// On top of either source sits the tick overlay (ticks.ts): the latest value
// the server pushed for a cell wins over the base value.
//
// Every request and reply is a User Timing entry, so it shows in a trace:
// "app: ws request #n" (a mark at send), "app: ws round trip #n" (send →
// reply handled) and "app: ws parse #n" (JSON.parse of the reply).

import { config } from "./config";
import { window_ } from "./rows.js";
import { mark, measure } from "./timing";

export type Cell = number | string;
export interface Source {
  readonly stats: { requests: number; cancelled: number; replies: number; bytes: number; cellsReceived: number; lastRoundTripMs: number; maxRoundTripMs: number; lastServerWaitMs: number };
  /** The window if every cell is available now; otherwise undefined (and, for ws, it is requested). */
  peek(y0: number, y1: number, x0: number, x1: number): Cell[][] | undefined;
  /** The window, waiting for the backend if needed. */
  get(y0: number, y1: number, x0: number, x1: number): Promise<Cell[][]>;
  /** Tell the source which window the screen wants now (lets `cancel`/`inflight` drop older wants). */
  want(y0: number, y1: number, x0: number, x1: number): void;
}

/** The latest pushed value per cell (row * 4096 + col), see ticks.ts. */
export const overlay = new Map<number, number>();
const patch = (rows: Cell[][], y0: number, x0: number) => {
  if (!overlay.size) return rows;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++) {
      const v = overlay.get((y0 + r) * 4096 + x0 + c);
      if (v !== undefined) rows[r][c] = v;
    }
  return rows;
};

const newStats = (): Source["stats"] => ({ requests: 0, cancelled: 0, replies: 0, bytes: 0, cellsReceived: 0, lastRoundTripMs: 0, maxRoundTripMs: 0, lastServerWaitMs: 0 });

export function localSource(): Source {
  const gen = (y0: number, y1: number, x0: number, x1: number) => patch(window_(y0, y1, x0, x1, config.rows) as Cell[][], y0, x0);
  return { stats: newStats(), peek: gen, get: async (y0, y1, x0, x1) => gen(y0, y1, x0, x1), want() {} };
}

export function wsUrl(path: string, params: Record<string, string | number>): string {
  const env = (window as any).__LAB_ENV ?? {};
  const port = config.net ? env.netemPort : location.port;
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return `ws://${location.hostname}:${port}${path}?${q}`;
}

export async function wsSource(): Promise<Source> {
  const socket = new WebSocket(
    wsUrl("/ws/rows", { serverMs: config.serverMs, jitterMs: config.jitterMs, conc: config.conc, rows: config.rows, padBytes: config.padBytes }),
  );
  await new Promise((open, fail) => {
    socket.onopen = open;
    socket.onerror = () => fail(new Error("cannot open " + socket.url));
  });
  const cache = new Map<number, Cell[]>(); // row → cells by column (holes = not received)
  const inFlight = new Map<number, { y0: number; y1: number; x0: number; x1: number; sent: number; cancelSent?: boolean }>();
  const waiting: { y0: number; y1: number; x0: number; x1: number; done: () => void }[] = [];
  let wanted: { y0: number; y1: number; x0: number; x1: number } | undefined;
  let pending: { y0: number; y1: number; x0: number; x1: number } | undefined; // inflight policy: newest unasked window
  const s = newStats();
  let nextId = 1;

  const has = (y0: number, y1: number, x0: number, x1: number) => {
    for (let r = y0; r < y1; r++) {
      const row = cache.get(r);
      if (!row) return false;
      for (let c = x0; c < x1; c++) if (row[c] === undefined) return false;
    }
    return true;
  };
  const collect = (y0: number, y1: number, x0: number, x1: number) => {
    const out: Cell[][] = [];
    for (let r = y0; r < y1; r++) out.push(cache.get(r)!.slice(x0, x1));
    return patch(out, y0, x0);
  };
  const covered = (r: number, x0: number, x1: number) => {
    const row = cache.get(r);
    if (row) {
      let all = true;
      for (let c = x0; c < x1; c++) if (row[c] === undefined) { all = false; break; }
      if (all) return true;
    }
    for (const f of inFlight.values()) if (r >= f.y0 && r < f.y1 && x0 >= f.x0 && x1 <= f.x1) return true;
    return false;
  };
  const send = (y0: number, y1: number, x0: number, x1: number) => {
    const id = nextId++;
    inFlight.set(id, { y0, y1, x0, x1, sent: performance.now() });
    s.requests++;
    socket.send(JSON.stringify({ id, y0, y1, x0, x1 }));
    mark(`app: ws request #${id}`, { detail: { id, y0, y1, x0, x1, inFlight: inFlight.size } });
  };
  const request = (y0: number, y1: number, x0: number, x1: number) => {
    if (config.policy === "inflight") {
      if (inFlight.size) return void (pending = { y0, y1, x0, x1 });
      return send(y0, y1, x0, x1);
    }
    // The row span not already cached or in flight for these columns.
    let lo = y0;
    while (lo < y1 && covered(lo, x0, x1)) lo++;
    let hi = y1;
    while (hi > lo && covered(hi - 1, x0, x1)) hi--;
    if (lo < hi) send(lo, hi, x0, x1);
  };

  socket.onmessage = (ev: MessageEvent<string>) => {
    const t0 = performance.now();
    const msg = JSON.parse(ev.data) as { id: number; y0: number; x0: number; rows: Cell[][]; cancelled?: boolean; srv: { recv: number; start: number; done: number } };
    const flight = inFlight.get(msg.id);
    inFlight.delete(msg.id);
    if (msg.cancelled) return;
    measure(`app: ws parse #${msg.id}`, { start: t0, detail: { bytes: ev.data.length } });
    msg.rows.forEach((cells, i) => {
      let row = cache.get(msg.y0 + i);
      if (!row) cache.set(msg.y0 + i, (row = []));
      for (let c = 0; c < cells.length; c++) row[msg.x0 + c] = cells[c];
      s.cellsReceived += cells.length;
    });
    s.replies++;
    s.bytes += ev.data.length;
    s.lastServerWaitMs = (msg.srv.start - msg.srv.recv) / 1000;
    if (flight) {
      s.lastRoundTripMs = performance.now() - flight.sent;
      s.maxRoundTripMs = Math.max(s.maxRoundTripMs, s.lastRoundTripMs);
      measure(`app: ws round trip #${msg.id}`, {
        start: flight.sent,
        detail: { id: msg.id, srvRecv: msg.srv.recv, srvStart: msg.srv.start, srvDone: msg.srv.done, bytes: ev.data.length },
      });
    }
    // Wake every get() whose cells are now all here.
    for (let i = waiting.length - 1; i >= 0; i--) {
      const w = waiting[i];
      if (has(w.y0, w.y1, w.x0, w.x1)) waiting.splice(i, 1)[0].done();
    }
    if (config.policy === "inflight" && pending && !inFlight.size) {
      const p = pending;
      pending = undefined;
      if (!has(p.y0, p.y1, p.x0, p.x1)) send(p.y0, p.y1, p.x0, p.x1);
    }
  };

  const clamp = (y1: number) => Math.min(y1, config.rows);
  return {
    stats: s,
    peek(y0, y1, x0, x1) {
      y1 = clamp(y1);
      if (has(y0, y1, x0, x1)) return collect(y0, y1, x0, x1);
      request(y0, y1, x0, x1);
      return undefined;
    },
    get(y0, y1, x0, x1) {
      y1 = clamp(y1);
      if (has(y0, y1, x0, x1)) return Promise.resolve(collect(y0, y1, x0, x1));
      request(y0, y1, x0, x1);
      return new Promise((resolve) => waiting.push({ y0, y1, x0, x1, done: () => resolve(collect(y0, y1, x0, x1)) }));
    },
    want(y0, y1, x0, x1) {
      wanted = { y0, y1, x0, x1 };
      if (config.policy !== "cancel") return;
      // Drop requests that no longer overlap what the screen wants.
      for (const [id, f] of inFlight)
        if (!f.cancelSent && (f.y1 <= wanted.y0 || f.y0 >= wanted.y1)) {
          f.cancelSent = true;
          socket.send(JSON.stringify({ cancel: id }));
          s.cancelled++;
          mark(`app: ws cancel #${id}`);
        }
    },
  };
}
