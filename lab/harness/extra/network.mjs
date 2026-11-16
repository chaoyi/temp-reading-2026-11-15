// Module 8 (network.html): cases the shared n- scenarios do not reach.
//
// n-hol-every-tanstack   The shared n-hol-regular has one request in flight at
//   a time (regular-table's draw loop), so no reply ever waits behind another.
//   This one asks for every range it passes, over the same link with the same
//   200 KB replies: eight replies queue on one ordered connection. A small
//   tick stream runs on its own socket beside it.
// n-flood-ticks / n-flood-drop   At 256 kbit/s the shared n-bw-256-* runs end
//   before the backlog gets past the kernel's socket buffers, so the server's
//   own queue (ws.bufferedAmount) stays at 0 and dropAbove never fires. Here
//   the stream starts small and jumps to about 20 MB/s into a 4 MB/s link
//   during the trace, so the order in which the queues fill is visible, with
//   and without dropAbove.
//
// Record each with its own `node harness/record.mjs <id>` run (a fresh lab
// server): the netem counter is shared by all connections of one server, and
// timers of an earlier scenario's connection keep reporting into the next.

const floodActions = [["wait", 300], ["eval", "window.__lab.setRate(800)"], ["wait", 3200]];
const flood = { lib: "tanstack", hz: 1, n: 2000, apply: "raf", span: 12, net: 1 };

export const scenarios = [
  {
    id: "n-hol-every-tanstack",
    asks: "Eight 200 KB replies asked for at once over a 4 Mbit/s link: how long does each wait behind the others, and does a second socket wait too?",
    query: { lib: "tanstack", source: "ws", net: 1, policy: "every", padBytes: 200_000, hz: 50, apply: "msg", span: 12 },
    actions: [["drag", { dy: 150, ms: 900, steps: 8 }], ["wait", 3600]],
    netem: { kbps: 4000 },
    endTimeoutMs: 8000,
  },
  {
    id: "n-flood-ticks",
    asks: "A stream jumps from 27 KB/s to about 20 MB/s into a 4 MB/s link: in which order do the queues fill, and when does the server notice?",
    query: flood,
    actions: floodActions,
    zero: "start",
    netem: { kbps: 32000 },
    endTimeoutMs: 8000,
  },
  {
    id: "n-flood-drop",
    asks: "The same flood; the server skips a send while its socket holds more than 16 KB: what does that bound, and what not?",
    query: { ...flood, dropAbove: 16384 },
    actions: floodActions,
    zero: "start",
    netem: { kbps: 32000 },
    endTimeoutMs: 8000,
  },
];
