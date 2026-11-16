// Module 3 (anatomy.html): loads chosen to test predictions made from the
// libraries' source, where the shared scenarios do not already exercise the
// mechanism.

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const diagonal = [["gesture", { distance: 2400, xDistance: 2400, speed: 2400, source: "mouse" }], ["wait", 600]];
// 2,000,000 rows of 24 px are 48,000,000 px: more than a browser lays out.
const reloadThenDragToEnd = [["eval", "location.reload()"], ["wait", 1800], ["drag", { dy: 290, ms: 700 }], ["wait", 900]];

export const scenarios = [
  {
    id: "a-diag-tanstack",
    asks: "Two virtualizers, scrolled diagonally: the second handler now reads layout and then renders too. How many renders and layouts per frame?",
    query: { lib: "tanstack", cols: 100, ...big },
    actions: diagonal,
    ...L,
  },
  {
    id: "a-diag-regular",
    asks: "regular-table scrolled diagonally into columns it has never measured: which draw pipeline runs?",
    query: { lib: "regular", cols: 100, ...big },
    actions: diagonal,
    ...L,
  },
  {
    id: "a-big-tanstack",
    asks: "2,000,000 rows in TanStack Virtual: what does the mount build per row, and which row does the end of the scrollbar reach?",
    query: { lib: "tanstack", rows: 2_000_000 },
    actions: reloadThenDragToEnd,
    zero: "start",
    endTimeoutMs: 8000,
  },
  {
    id: "a-big-regular",
    asks: "2,000,000 rows in regular-table: the same mount and the same drag to the end.",
    query: { lib: "regular", rows: 2_000_000 },
    actions: reloadThenDragToEnd,
    zero: "start",
    endTimeoutMs: 8000,
  },
  {
    // The shared s-msg-* scenarios use the local source, whose draws finish in
    // microtasks, so no draw() ever finds another in flight. Here every draw
    // that moves waits 30 ms for the backend.
    id: "a-lock-regular",
    asks: "500 draw() requests a second while regular-table scrolls over a 30 ms backend: of the callers that find a draw in flight, how many run?",
    query: { lib: "regular", source: "ws", serverMs: 30, hz: 500, apply: "msg", span: 2000 },
    actions: [["wait", 300], ["gesture", { distance: 1200, speed: 1200, source: "mouse" }], ["wait", 700]],
  },
];
