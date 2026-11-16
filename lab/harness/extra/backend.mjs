// Module 6 (backend.html): three loads that test what the shared b- scenarios
// left open.

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const scroll = (speed, seconds = 1) => ["gesture", { distance: Math.round(speed * seconds), speed, source: "mouse" }];

export const scenarios = [
  {
    // b-jitter-regular cannot show replies overtaking each other: regular-table
    // has one request out at a time. Our TanStack source with policy "every"
    // has several.
    id: "b-jitter-every-tanstack",
    asks: "Service time 5–45 ms and several requests in flight: replies overtake each other. What does the page do with a reply that arrives out of order?",
    query: { lib: "tanstack", source: "ws", serverMs: 25, jitterMs: 20, policy: "every" },
    actions: [scroll(1200), ["wait", 700]],
  },
  {
    // The prediction from b-scroll-ws-tanstack: rows are filled only when
    // nothing is in flight; at one new row per frame or more that never
    // happens while the scroll runs.
    id: "b-scroll-fast-ws-tanstack",
    asks: "The 30 ms backend again, scrolled twice as fast (more than one new row per frame): when are rows filled?",
    query: { lib: "tanstack", source: "ws", serverMs: 30 },
    actions: [scroll(2400), ["wait", 700]],
  },
  {
    // padBytes pads a reply with one long string. This asks for a reply that
    // is large because it holds many cells: 40 columns, 60 rows of overscan on
    // each side, and a drag so that every step needs a whole new window.
    id: "b-window-drag-tanstack",
    asks: "A reply that is large because it holds thousands of cells (not one padded string): what does JSON.parse cost per megabyte, and how does it compare with drawing the cells?",
    query: { lib: "tanstack", cols: 40, colv: 0, overscan: 60, source: "ws", serverMs: 5, ...big },
    actions: [["drag", { dy: 150, ms: 900 }], ["wait", 800]],
    ...L,
  },
];
