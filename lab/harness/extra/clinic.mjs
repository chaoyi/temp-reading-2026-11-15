// The clinic's unlabelled traces (Module 11). `hidden: true` keeps the knobs
// out of the page URL and the trace metadata; this file and clinic.html hold
// the answers. Each `asks` is the complaint a user might file.

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const scroll = (speed, seconds = 1) => ["gesture", { distance: Math.round(speed * seconds), speed, source: "mouse" }];

export const scenarios = [
  {
    id: "c-1",
    asks: "Wheel scrolling feels sticky: the table lags behind the wheel and then jumps.",
    query: { lib: "tanstack", wheel: "blocking" },
    actions: [["eval", "window.__lab.jank(180, 110)"], ["wait", 250], ["wheel", { n: 30, every: 33 }], ["wait", 800]],
    before: 60,
  },
  {
    id: "c-2",
    asks: "Dragging the scrollbar shows rows of '…' that fill in late, and later and later the longer the drag. The backend team says every query takes 25 ms.",
    query: { lib: "tanstack", source: "ws", serverMs: 25, conc: 1, policy: "every" },
    actions: [["drag", { dy: 220, ms: 1500, steps: 60 }], ["wait", 2200]],
  },
  {
    id: "c-3",
    asks: "Prices on screen are more and more out of date the longer the page is open, although the server sends on time.",
    query: { lib: "regular", hz: 6000, apply: "msg", span: 12 },
    actions: [["wait", 1500]],
    zero: "start",
    endTimeoutMs: 20000,
  },
  {
    id: "c-4",
    asks: "Scrolling is smooth on a laptop and janky on the large wall display driven by a small PC.",
    query: { lib: "regular", cols: 100, fmt: "newintl", cls: 1, ...big },
    actions: [scroll(2400), ["wait", 900]],
    cpu: 4,
    ...L,
  },
  {
    id: "c-5",
    asks: "The table scrolls without visible problems, but the tab uses far more CPU than its sibling built on the same library.",
    query: { lib: "regular", cols: 100, rtReset: 1, ...big },
    actions: [scroll(2400), ["wait", 700]],
    ...L,
  },
  {
    id: "c-6",
    asks: "During a fast fling the list shows blank areas before the content appears.",
    query: { lib: "tanstack", cols: 100, paint: "heavy", ...big },
    actions: [scroll(9600), ["wait", 800]],
    ...L,
  },
  {
    id: "c-7",
    asks: "After the Wi-Fi drops for a second, the table freezes, then values jump and the page stutters.",
    query: { lib: "react", hz: 800, apply: "msg", net: 1, span: 12 },
    actions: [["wait", 3200]],
    zero: "start",
    netem: { stallAtMs: 1300, stallMs: 1300 },
    endTimeoutMs: 20000,
  },
  {
    id: "c-8",
    asks: "While the dashboard is live, Page Down takes a moment to respond; dragging the scrollbar does not.",
    query: { lib: "regular", hz: 3000, apply: "msg", span: 2000 },
    actions: [["wait", 300], ["keys", { n: 4, every: 250 }], ["wait", 900]],
  },
].map((s) => ({ hidden: true, ...s }));
