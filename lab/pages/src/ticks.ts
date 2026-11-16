// Live updates: the server pushes cell values on its own clock (/ws/ticks),
// and this module decides when they reach the DOM. Three policies (apply=):
//
//   msg     every WebSocket message is applied to the table at once, inside
//           its own task. The simplest code; work is proportional to the
//           message rate, whatever the display can show.
//   raf     a message only updates the overlay (latest value per cell) and
//           marks cells dirty; one requestAnimationFrame callback per frame
//           applies whatever is dirty. Work is bounded by the frame rate.
//   worker  the socket lives in a Worker, which parses and conflates; the
//           page asks for the dirty cells once per frame and applies the
//           reply. Parsing and conflation leave the main thread.
//
// Each applied batch is a User Timing measure "app: tick apply" whose detail
// carries the newest sequence number and the server send times (µs on the
// trace clock) of the oldest and newest update in the batch, so an analysis
// can compute how old the data was when it reached the DOM. "app: tick
// message" marks each message as it is handled on the main thread.

import { config } from "./config";
import { overlay, wsUrl } from "./source";
import { mark, measure } from "./timing";

export type Update = [row: number, col: number, value: number];
export interface TickStats { messages: number; cells: number; applies: number; lastSeq: number; gaps: number; maxAgeMs: number; lastAgeMs: number; bytes: number }
export const tickStats: TickStats = { messages: 0, cells: 0, applies: 0, lastSeq: 0, gaps: 0, maxAgeMs: 0, lastAgeMs: 0, bytes: 0 };

type Apply = (cells: Update[]) => void;
let control: ((m: object) => void) | undefined;
export const setRate = (hz: number) => control?.({ hz });

function params() {
  return { hz: config.tickHz, n: config.tickN, span: config.tickSpan, cols: config.cols, conflate: config.conflateMs, wire: config.wire, dropAbove: config.dropAbove };
}

/** Decode one message: sequence number, send time, oldest-update time, updates. */
export function decode(data: string | ArrayBuffer): { s: number; t: number; f: number; u: Update[] } {
  if (typeof data === "string") return JSON.parse(data);
  const a = new Float64Array(data);
  const u: Update[] = [];
  for (let i = 3; i < a.length; i += 3) u.push([a[i], a[i + 1], a[i + 2]]);
  return { s: a[0], t: a[1], f: a[2], u };
}

export function startTicks(apply: Apply) {
  if (!config.tickHz) return;
  if (config.apply === "worker") return startWorker(apply);

  const socket = new WebSocket(wsUrl("/ws/ticks", params()));
  socket.binaryType = "arraybuffer";
  control = (m) => socket.send(JSON.stringify(m));
  const dirty = new Map<number, Update>();
  let oldest = 0; // send time of the oldest update not yet applied
  let newest = 0;
  let seq = 0;
  let scheduled = false;

  const flush = (start: number) => {
    const cells = [...dirty.values()];
    dirty.clear();
    apply(cells);
    tickStats.applies++;
    measure("app: tick apply", { start, detail: { seq, cells: cells.length, oldestUs: oldest, newestUs: newest } });
    oldest = 0;
  };
  socket.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
    const t0 = performance.now();
    const m = decode(ev.data);
    tickStats.messages++;
    tickStats.cells += m.u.length;
    tickStats.bytes += typeof ev.data === "string" ? ev.data.length : ev.data.byteLength;
    if (tickStats.lastSeq && m.s > tickStats.lastSeq + 1 && !config.conflateMs) tickStats.gaps += m.s - tickStats.lastSeq - 1;
    tickStats.lastSeq = seq = m.s;
    for (const u of m.u) {
      overlay.set(u[0] * 4096 + u[1], u[2]);
      dirty.set(u[0] * 4096 + u[1], u);
    }
    if (!oldest) oldest = m.f;
    newest = m.t;
    mark("app: tick message", { detail: { seq: m.s, sentUs: m.t } });
    if (config.apply === "msg") flush(t0);
    else if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        flush(performance.now());
      });
    }
  };
}

function startWorker(apply: Apply) {
  const worker = new Worker(new URL("./ticks.worker.ts", import.meta.url), { type: "module" });
  worker.postMessage({ url: wsUrl("/ws/ticks", params()) });
  control = (m) => worker.postMessage({ control: m });
  let asked = false;
  worker.onmessage = (ev: MessageEvent<{ seq: number; oldestUs: number; newestUs: number; messages: number; bytes: number; cells: Float64Array }>) => {
    const t0 = performance.now();
    asked = false;
    const { seq, oldestUs, newestUs, messages, bytes, cells } = ev.data;
    tickStats.messages += messages;
    tickStats.bytes += bytes;
    tickStats.lastSeq = seq;
    if (!cells.length) return;
    const updates: Update[] = [];
    for (let i = 0; i < cells.length; i += 3) {
      updates.push([cells[i], cells[i + 1], cells[i + 2]]);
      overlay.set(cells[i] * 4096 + cells[i + 1], cells[i + 2]);
    }
    tickStats.cells += updates.length;
    apply(updates);
    tickStats.applies++;
    measure("app: tick apply", { start: t0, detail: { seq, cells: updates.length, oldestUs, newestUs } });
  };
  // One pull per frame; at most one in flight.
  const pull = () => {
    if (!asked) {
      asked = true;
      worker.postMessage({ pull: true });
    }
    requestAnimationFrame(pull);
  };
  requestAnimationFrame(pull);
}
