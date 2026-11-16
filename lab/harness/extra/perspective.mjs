// Module 9 (perspective.html): "change one input" probes for findings made in
// the x- traces. Same shape as the psp(...) entries in ../scenarios.mjs.
//
// The lab's Perspective server keeps the update rate last set through
// /__psp for as long as it runs, and one server serves a whole recording
// run. Every remote probe here therefore sets the rate it wants in `setup`
// (the page itself only sets it when hz > 0).

const scroll = (speed, seconds = 1) => ["gesture", { distance: Math.round(speed * seconds), speed, source: "mouse" }];
const psp = (query, actions, more = {}) => ({ page: "psp.html", query, actions, psp: true, viewport: { width: 1000, height: 600 }, ...more });
const quiet = "fetch('/__psp?hz=0').then(() => true)";

export const scenarios = [
  {
    id: "x-probe-sort-remote",
    asks: "The sort on the server with no update stream running: the config change alone.",
    ...psp({ engine: "remote" }, [["eval", "void window.__lab.restore({ sort: [['price', 'desc']] })"], ["wait", 1000]], { zero: "start", setup: quiet }),
  },
  {
    id: "x-probe-offscreen",
    asks: "100 updates a second to rows that are sorted out of view: does the datagrid still fetch and draw?",
    ...psp({ engine: "worker", hz: 100, sort: "price" }, [["wait", 1000]], { zero: "start", setup: quiet }),
  },
  {
    id: "x-probe-throttle",
    asks: "The 100 updates a second of x-stream-worker-100 with viewer.setThrottle(100): which of the per-update costs does a throttle remove?",
    ...psp({ engine: "worker", hz: 100, throttle: 100 }, [["wait", 1000]], { zero: "start", setup: quiet }),
  },
  {
    id: "x-probe-lat50-throttle0",
    asks: "x-stream-remote-lat50 with viewer.setThrottle(0): how much of the 0.8 s between draws was the adaptive throttle?",
    ...psp({ engine: "remote", hz: 100, net: 1, throttle: 0 }, [["wait", 2500]], { zero: "start", netem: { latencyMs: 50 } }),
  },
  {
    id: "x-probe-scroll-tail",
    asks: "50 updates a second, a two-second scroll, then 1.8 s of rest: when do update draws come back?",
    ...psp({ engine: "worker", hz: 50 }, [["wait", 300], scroll(2400), ["wait", 1800]], { setup: quiet }),
  },
];
