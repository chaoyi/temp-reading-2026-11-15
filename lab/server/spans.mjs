// The backend's own trace: spans, instants and counters on the same clock
// Chrome's trace uses. On Linux both are CLOCK_MONOTONIC in microseconds
// (Node: process.hrtime; Chrome: base::TimeTicks), so the harness can append
// these events to a Chrome trace and a viewer shows browser and backend on
// one time axis. The format is the Chrome JSON trace-event format.

export const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/** Named lanes of the backend process, shown as threads in a viewer. */
export const TRACKS = {
  io: [1, "ws io (recv/send)"],
  query: [2, "query service"],
  ticks: [3, "tick producer"],
  netem: [4, "netem proxy"],
  psp: [5, "perspective session"],
};

const MAX = 400_000;
let events = [];
let dropped = 0;
let enabled = true;

function push(e) {
  if (!enabled) return;
  if (events.length >= MAX) return void dropped++;
  events.push(e);
}

const pid = process.pid;
const cat = "backend";

/** A complete span on a track: [startUs, startUs + durUs]. */
export function span(track, name, startUs, durUs, args) {
  push({ ph: "X", cat, name, pid, tid: TRACKS[track][0], ts: startUs, dur: Math.max(1, durUs), args });
}
/** A moment on a track. */
export function instant(track, name, ts = nowUs(), args) {
  push({ ph: "i", s: "t", cat, name, pid, tid: TRACKS[track][0], ts, args });
}
/** A numeric series (a counter track in Perfetto). */
export function counter(name, value, ts = nowUs()) {
  push({ ph: "C", cat, name, pid, ts, args: { value } });
}
/** One step of a flow arrow; `id` ties the steps together across processes. */
export function flow(track, phase, id, ts) {
  push({ ph: phase, cat: "rpc", name: "rpc", id, pid, tid: TRACKS[track][0], ts, ...(phase === "f" ? { bp: "e" } : {}) });
}

export function drain() {
  const meta = [
    { ph: "M", name: "process_name", pid, tid: 0, args: { name: "Backend (node)" } },
    { ph: "M", name: "process_sort_index", pid, tid: 0, args: { sort_index: 50 } },
    ...Object.values(TRACKS).map(([tid, name]) => ({ ph: "M", name: "thread_name", pid, tid, args: { name } })),
  ];
  const out = { pid, dropped, events: [...meta, ...events] };
  events = [];
  dropped = 0;
  return out;
}
export const setEnabled = (on) => void (enabled = on);
