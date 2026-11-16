// Module 7 (streaming.html): loads the shared s- scenarios do not have.
//
//   s-ramp-fine-regular  The shared ramp doubles the rate (… 4000, 8000), so it
//                        only says the knee is somewhere between the two. This
//                        one climbs in steps of 1000 through that interval.
//   s-scroll-flood-regular  The shared scroll scenarios run at 2000-4000
//                        messages a second, far below the knee. This one
//                        scrolls while more arrives than the thread can do.
//                        The main thread is throttled 4x so that 3000
//                        messages a second are already too many: the same
//                        overload in a trace a quarter of the size.
//   s-quiet-*            The same 8000 messages a second with marks=0: the page
//                        writes no performance.mark / measure. Without marks
//                        there is no data-age metric; what remains (tasks,
//                        frames, main-thread time) shows what the instruments
//                        themselves cost, and whether the knee moves.

const rate = (hz) => ["eval", `window.__lab.setRate(${hz})`];

export const scenarios = [
  {
    id: "s-ramp-fine-regular",
    asks: "4000, 5000, 6000, 7000 messages a second into regular-table, 250 ms each, then stop: at which step does data age start to climb?",
    query: { lib: "regular", hz: 4000, apply: "msg", span: 12 },
    actions: [["wait", 250], ...[5000, 6000, 7000].flatMap((hz) => [rate(hz), ["wait", 250]]), rate(0), ["wait", 700]],
    zero: "start",
    endTimeoutMs: 20000,
  },
  {
    id: "s-quiet-msg-8000-tanstack",
    asks: "8000 messages a second patched per message, with our own marks and measures switched off: what was the instrumentation costing?",
    query: { lib: "tanstack", hz: 8000, apply: "msg", span: 12, n: 1, marks: 0 },
    actions: [["wait", 800]],
    zero: "start",
  },
  {
    id: "s-quiet-msg-8000-regular",
    asks: "8000 messages a second, a draw per message, with marks and measures off: is the overload still there?",
    query: { lib: "regular", hz: 8000, apply: "msg", span: 12, n: 1, marks: 0 },
    actions: [["wait", 800]],
    zero: "start",
    endTimeoutMs: 20000,
  },
  {
    id: "s-scroll-flood-regular",
    asks: "Scrolling while more messages arrive than the main thread can handle (3000 a second, each requesting a draw, main thread 4x slower): what does the scroll get, and what does the content get?",
    query: { lib: "regular", hz: 3000, apply: "msg", span: 2000 },
    actions: [["wait", 100], ["gesture", { distance: 700, speed: 2400, source: "mouse" }], ["wait", 250]],
    cpu: 4,
    endTimeoutMs: 20000,
  },
];
