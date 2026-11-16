// Every traced scenario: what it asks, the page configuration, and the input.
// record.mjs plays them; the course pages cite them by id.
//
// Naming: <module>-<what>-<variant>. Modules: f frames, j JavaScript,
// r rendering, b backend, s streaming, n network, u upstream showcases,
// x Perspective, c clinic.

const L = { viewport: { width: 1640, height: 860 } }; // large table: about 15 × 32 cells visible
const big = { w: 1560, h: 792 };
/**
 * A constant-speed scroll, synthesized by the browser as wheel input: `speed`
 * px/s for `seconds`, played twice back to back (repeat: 1), with a pause of
 * about 70 ms between the two gestures. So scroll(2400) is about two seconds
 * and 4,800 px of scrolling.
 */
const scroll = (speed, seconds = 1) => ["gesture", { distance: Math.round(speed * seconds), speed, source: "mouse", repeat: 1 }];
const S = [];
const add = (id, asks, spec) => S.push({ id, asks, module: id.split("-")[0], ...spec });
const grid = (query, actions, more = {}) => ({ page: "grid.html", query, actions, ...more });

// ── f: frames ────────────────────────────────────────────────────────────
for (const lib of ["tanstack", "regular", "react"])
  add(`f-scroll-${lib}`, "A steady scroll with nothing wrong (two one-second gestures back to back): what does every frame look like?", grid({ lib }, [scroll(2400), ["wait", 500]]));
add("f-click-tanstack", "A scrollbar click animates on the compositor: which frames carry a main-thread update?", grid({ lib: "tanstack" }, [["click-track"], ["wait", 700]]));
for (const us of [0, 50, 150, 250, 600])
  add(`f-budget-${us}`, `Each visible cell costs ${us} µs to format: what happens to frames as a draw crosses 16.7 ms?`, grid({ lib: "regular", formatUs: us }, [scroll(2400), ["wait", 700]], { shots: us === 250 || us === 600 }));
for (const rate of [4, 8, 20])
  add(`f-cpu-${rate}x`, `The same scroll with the main thread ${rate}× slower: which frames survive?`, grid({ lib: "regular", ...big }, [scroll(2400), ["wait", 900]], { ...L, cpu: rate }));
for (const lib of ["tanstack", "regular"])
  add(`f-longtask-${lib}`, "A 250 ms task blocks the main thread while a scroll animation runs: what do the frame records say?", grid({ lib }, [["evalNoWait", "window.__lab.longTask(250)"], ["wait", 30], ["click-track"], ["wait", 800]], { before: 60, shots: true }));
add("f-obs-msg", "One cell changes five times a second: when is it in the DOM, and when is it on screen?", grid({ lib: "tanstack", hz: 5, n: 1, span: 12, apply: "msg" }, [["wait", 1600]], { zero: "start" }));
add("f-obs-raf", "The same updates applied in requestAnimationFrame: does the screen get them sooner or later?", grid({ lib: "tanstack", hz: 5, n: 1, span: 12, apply: "raf" }, [["wait", 1600]], { zero: "start" }));
add("f-marks-on", "What does our own instrumentation cost? With performance.measure calls.", grid({ lib: "tanstack", ...big }, [scroll(2400), ["wait", 400]], L));
add("f-marks-off", "The same scroll with every performance.mark and measure removed.", grid({ lib: "tanstack", ...big, marks: 0 }, [scroll(2400), ["wait", 400]], L));
const DEVTOOLS_ONLY = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "latencyInfo", "cc", "benchmark"];
add("f-observer-min", "The same scroll traced with only the categories the analysis needs, and no JavaScript sampling: how much do the instruments add?", grid({ lib: "regular", cols: 100, ...big }, [scroll(2400), ["wait", 400]], { ...L, onlyCategories: DEVTOOLS_ONLY }));
add("f-observer-default", "… with this course's default categories (sampling every 0.1 ms, compositor, scheduler, every task).", grid({ lib: "regular", cols: 100, ...big }, [scroll(2400), ["wait", 400]], L));
add("f-observer-blink", "… and with Blink's internal category on top, which writes an event for every piece of text it shapes.", grid({ lib: "regular", cols: 100, ...big }, [scroll(2400), ["wait", 400]], { ...L, categories: ["blink"] }));
add("f-variance", "Ten runs of one scenario: how much do the numbers move?", grid({ lib: "regular", ...big }, [scroll(2400), ["wait", 400]], { ...L, runs: 10 }));

// ── j: JavaScript cost ───────────────────────────────────────────────────
const sizes = { S: [{}, {}], M: [{ w: 1000, h: 504 }, { viewport: { width: 1080, height: 580 } }], L: [big, L] };
for (const [size, [q, vp]] of Object.entries(sizes))
  for (const lib of ["tanstack", "regular", "react"])
    add(`j-cells-${size}-${lib}`, `How does the cost of a scroll step grow with the number of visible cells? (${size})`, grid({ lib, cols: 100, ...q }, [scroll(2400), ["wait", 500]], vp));
for (const speed of [600, 2400, 9600, 38400])
  for (const [name, q] of [["keyed", { lib: "tanstack", pool: "keyed" }], ["positional", { lib: "tanstack", pool: "positional" }], ["regular", { lib: "regular" }]])
    add(`j-speed-${speed}-${name}`, `Scrolling at ${speed} px/s: how many cells does each reuse policy write per frame?`, grid({ ...q, cols: 100, ...big }, [scroll(speed), ["wait", 500]], L));
for (const fmt of ["plain", "intl", "locale", "newintl"])
  add(`j-fmt-${fmt}`, `Number formatting with fmt=${fmt}: what does one cell cost?`, grid({ lib: "regular", cols: 100, fmt, ...big }, [scroll(2400), ["wait", 500]], L));
add("j-react-memo", "React rows wrapped in memo: what does it save on a scroll?", grid({ lib: "react", cols: 100, memo: 1, ...big }, [scroll(2400), ["wait", 500]], L));
add("j-react-overscan", "React with overscan 10: fewer renders, or more work per render?", grid({ lib: "react", cols: 100, overscan: 10, ...big }, [scroll(2400), ["wait", 500]], L));
for (const kb of [0, 512, 4096])
  add(`j-gc-${kb}`, `Each draw allocates ${kb} KB of short-lived objects: when does the garbage collector run, and what does it cost?`, grid({ lib: "regular", cols: 100, alloc: kb, ...big }, [scroll(2400, 1.2), ["wait", 400]], L));
for (const lib of ["regular", "react"])
  add(`j-warmup-${lib}`, "The first scroll after load against the second: what changes as V8 optimizes the code?", grid({ lib, cols: 100, ...big }, [scroll(2400, 0.6), ["wait", 500], scroll(2400, 0.6), ["wait", 400]], { ...L, warmMs: 150, categories: ["disabled-by-default-v8.compile"] }));

// ── r: style, layout, paint, compositing ─────────────────────────────────
add("r-two-virtualizers", "Two virtualizers on one scroller: why is there a layout inside the scroll event?", grid({ lib: "tanstack", cols: 12, ...big }, [scroll(2400), ["wait", 500]], L));
add("r-one-virtualizer", "The same table with only the row virtualizer.", grid({ lib: "tanstack", cols: 12, colv: 0, ...big }, [scroll(2400), ["wait", 500]], L));
for (const lib of ["tanstack", "regular"])
  add(`r-thrash-${lib}`, "A layout read after every write: how many layouts, and how big is each?", grid({ lib, cols: 100, thrash: 1, ...big }, [scroll(2400), ["wait", 500]], L));
add("r-autosize-reset", "regular-table told to forget its column widths on every scroll: which draw path runs now?", grid({ lib: "regular", cols: 100, rtReset: 1, ...big }, [scroll(2400), ["wait", 700]], L));
for (const lib of ["tanstack", "regular"])
  add(`r-cls-${lib}`, "Conditional classes on every cell: what does style recalculation cost?", grid({ lib, cols: 100, cls: 1, ...big }, [scroll(2400), ["wait", 500]], L));
add("r-contain-tanstack", "CSS containment on rows and cells: does layout get cheaper?", grid({ lib: "tanstack", cols: 100, contain: 1, ...big }, [scroll(2400), ["wait", 500]], L));
add("r-contain-regular", "CSS containment on regular-table's cells.", grid({ lib: "regular", cols: 100, contain: 1, ...big }, [scroll(2400), ["wait", 500]], L));
for (const lib of ["tanstack", "regular"])
  add(`r-paint-heavy-${lib}`, "Blurred shadows on every cell: which threads pay, and does the scroll show unpainted tiles?", grid({ lib, cols: 100, paint: "heavy", ...big }, [scroll(9600), ["wait", 700]], { ...L, shots: true }));
add("r-paint-plain-fast", "The control for heavy paint: plain cells at the same speed.", grid({ lib: "tanstack", cols: 100, ...big }, [scroll(9600), ["wait", 700]], L));
for (const wheel of ["none", "passive", "blocking"])
  add(`r-wheel-${wheel}`, `A wheel listener (${wheel}) while the main thread is busy 100 ms out of every 150: who waits for whom?`, grid({ lib: "tanstack", wheel }, [["eval", "window.__lab.jank(150, 100)"], ["wait", 200], ["wheel", { n: 30, every: 33 }], ["wait", 700]], { before: 60 }));
add("r-dsf1", "Device scale factor 1, opaque scroller: is the scroll still composited?", grid({ lib: "tanstack" }, [["evalNoWait", "window.__lab.longTask(250)"], ["wait", 30], ["click-track"], ["wait", 800]], { dsf: 1, before: 60 }));

// ── b: a backend, request/response ───────────────────────────────────────
for (const lib of ["tanstack", "regular"])
  add(`b-click-ws-${lib}`, "One page step with rows from a WebSocket backend 5 ms away: follow one request through both processes.", grid({ lib, source: "ws", serverMs: 5 }, [["click-track"], ["wait", 700]]));
for (const policy of ["every", "inflight", "cancel"])
  add(`b-drag-${policy}-tanstack`, `A thumb drag against a backend that serves one 40 ms query at a time, request policy "${policy}": how long is the line?`, grid({ lib: "tanstack", source: "ws", serverMs: 40, conc: 1, policy }, [["drag", { dy: 150, ms: 900 }], ["wait", 2500]], { shots: policy !== "cancel" }));
add("b-drag-regular", "regular-table against the same one-at-a-time backend: its draw loop is the request policy.", grid({ lib: "regular", source: "ws", serverMs: 40, conc: 1 }, [["drag", { dy: 150, ms: 900 }], ["wait", 1500]], { shots: true }));
add("b-drag-every-parallel", "The same drag, but the backend serves every query at once: where does the load go?", grid({ lib: "tanstack", source: "ws", serverMs: 40, conc: 0, policy: "every" }, [["drag", { dy: 150, ms: 900 }], ["wait", 1200]]));
add("b-jitter-regular", "Service time 5–45 ms: replies arrive out of order. What does a draw wait for?", grid({ lib: "regular", source: "ws", serverMs: 25, jitterMs: 20 }, [scroll(1200), ["wait", 700]]));
add("b-scroll-ws-tanstack", "A steady scroll with a 30 ms backend: placeholders, and how late is the content?", grid({ lib: "tanstack", source: "ws", serverMs: 30 }, [scroll(1200), ["wait", 700]], { shots: true }));
add("b-scroll-ws-regular", "The same scroll in regular-table: stale rows instead of placeholders.", grid({ lib: "regular", source: "ws", serverMs: 30 }, [scroll(1200), ["wait", 700]], { shots: true }));
add("b-wide-tanstack", "A large window from the backend (15 × 32 cells and overscan): bytes, parse time, and where parsing runs.", grid({ lib: "tanstack", cols: 100, source: "ws", serverMs: 5, ...big }, [scroll(2400), ["wait", 700]], L));
add("b-pad-1mb", "Each reply padded to 1 MB: what does a large message cost the main thread?", grid({ lib: "regular", source: "ws", serverMs: 5, padBytes: 1_000_000 }, [scroll(1200), ["wait", 900]]));

// ── s: streaming updates ─────────────────────────────────────────────────
const stream = (q, ms = q.hz >= 8000 ? 1200 : 2000, more = {}) => grid({ span: 12, n: 1, ...q }, [["wait", ms]], { zero: "start", ...more });
for (const hz of [60, 500, 2000, 8000]) add(`s-msg-${hz}-tanstack`, `${hz} messages a second, each applied at once (keyed cells patched in place): does the page keep up?`, stream({ lib: "tanstack", hz, apply: "msg" }));
for (const hz of [2000, 8000]) add(`s-raf-${hz}-tanstack`, `${hz} messages a second, applied once per frame.`, stream({ lib: "tanstack", hz, apply: "raf" }));
add("s-worker-8000-tanstack", "8000 messages a second parsed and conflated in a worker; the page pulls once per frame.", stream({ lib: "tanstack", hz: 8000, apply: "worker" }));
add("s-conflate-8000-tanstack", "8000 updates a second conflated on the server to one message per 16 ms.", stream({ lib: "tanstack", hz: 8000, apply: "msg", conflate: 16 }));
add("s-bin-8000-tanstack", "8000 messages a second as binary records instead of JSON, applied per frame.", stream({ lib: "tanstack", hz: 8000, apply: "raf", wire: "bin" }));
for (const hz of [60, 500, 2000]) add(`s-msg-${hz}-regular`, `${hz} messages a second into regular-table, a draw requested per message: what does its draw loop do with them?`, stream({ lib: "regular", hz, apply: "msg" }));
add("s-raf-2000-regular", "2000 messages a second into regular-table, one draw request per frame.", stream({ lib: "regular", hz: 2000, apply: "raf" }));
for (const hz of [60, 500, 2000]) add(`s-msg-${hz}-react`, `${hz} messages a second into React state, one render per message.`, stream({ lib: "react", hz, apply: "msg" }));
add("s-raf-2000-react", "2000 messages a second into React, one render per frame.", stream({ lib: "react", hz: 2000, apply: "raf" }));
add("s-react-memo-2000", "The same with memoized rows: only rows whose value changed render.", stream({ lib: "react", hz: 2000, apply: "raf", memo: 1 }));
add("s-msg-8000-regular", "8000 messages a second, each asking regular-table for a draw: more work arrives than one thread can do.", stream({ lib: "regular", hz: 8000, apply: "msg" }, 1500, { endTimeoutMs: 20000 }));
add("s-raf-8000-regular", "The same 8000 messages a second with one draw request per frame.", stream({ lib: "regular", hz: 8000, apply: "raf" }));
add("s-msg-8000-react", "8000 messages a second into React, a render per message.", stream({ lib: "react", hz: 8000, apply: "msg" }, 1500, { endTimeoutMs: 20000 }));
add("s-msg-2000x20-tanstack", "2000 messages a second of 20 cells each (40,000 cell updates a second), patched per message.", stream({ lib: "tanstack", hz: 2000, n: 20, apply: "msg" }));
add("s-batch-60x50", "60 messages a second of 50 cells each: the same cell rate as 3000 single updates, in fewer messages.", stream({ lib: "tanstack", hz: 60, n: 50, apply: "msg" }));
add("s-scroll-msg-2000-regular", "Scrolling while 2000 messages a second each request a draw: does the scroll stay smooth?", grid({ lib: "regular", hz: 2000, apply: "msg", span: 2000 }, [["wait", 400], scroll(2400), ["wait", 600]]));
add("s-scroll-raf-2000-regular", "The same with one draw request per frame.", grid({ lib: "regular", hz: 2000, apply: "raf", span: 2000 }, [["wait", 400], scroll(2400), ["wait", 600]]));
add("s-scroll-msg-4000-tanstack", "Scrolling the keyed table under 4000 per-message updates a second.", grid({ lib: "tanstack", hz: 4000, apply: "msg", span: 2000 }, [["wait", 400], scroll(2400), ["wait", 600]]));
add("s-ramp-regular", "The same ramp into regular-table, a draw request per message: at which rate does the backlog start?", grid({ lib: "regular", hz: 250, apply: "msg", span: 12 }, [["wait", 400], ...[500, 1000, 2000, 4000, 8000].flatMap((hz) => [["eval", `window.__lab.setRate(${hz})`], ["wait", 400]]), ["eval", "window.__lab.setRate(0)"], ["wait", 2500]], { zero: "start", endTimeoutMs: 20000 }));
add("s-ramp-tanstack", "The rate doubles every 400 ms from 500 to 16000 messages a second: where is the knee?", grid({ lib: "tanstack", hz: 500, apply: "msg", span: 12 }, [["wait", 400], ...[1000, 2000, 4000, 8000, 16000].flatMap((hz) => [["eval", `window.__lab.setRate(${hz})`], ["wait", 400]]), ["eval", "window.__lab.setRate(0)"], ["wait", 1500]], { zero: "start", endTimeoutMs: 15000 }));

// ── n: bad networks and overload ─────────────────────────────────────────
for (const ms of [25, 100, 500])
  for (const lib of ["tanstack", "regular"])
    add(`n-lat-${ms}-${lib}`, `A scroll with ${ms} ms of one-way network delay (${2 * ms} ms round trip): what is on screen meanwhile?`, grid({ lib, source: "ws", net: 1, policy: lib === "tanstack" ? "inflight" : "every" }, [scroll(1200), ["wait", 600 + 4 * ms]], { netem: { latencyMs: ms }, shots: ms >= 100 }));
add("n-lat-500-tanstack-every", "The same 1-second round trip, but the page asks for every range it passes.", grid({ lib: "tanstack", source: "ws", net: 1, policy: "every" }, [scroll(1200), ["wait", 2600]], { netem: { latencyMs: 500 } }));
for (const apply of ["msg", "raf"])
  add(`n-stall-${apply}-tanstack`, `The network stalls for 1.5 s while 500 messages a second are flowing, then delivers everything at once (apply=${apply}).`, grid({ lib: "tanstack", hz: 500, apply, span: 12, net: 1 }, [["wait", 3200]], { zero: "start", netem: { stallAtMs: 1300, stallMs: 1500 } }));
add("n-stall-msg-regular", "The same stall and burst into regular-table, a draw request per message.", grid({ lib: "regular", hz: 500, apply: "msg", span: 12, net: 1 }, [["wait", 3200]], { zero: "start", netem: { stallAtMs: 1300, stallMs: 1500 } }));
add("n-stall-msg-react", "The same stall and burst into React, a render per message.", grid({ lib: "react", hz: 500, apply: "msg", span: 12, net: 1 }, [["wait", 3200]], { zero: "start", netem: { stallAtMs: 1300, stallMs: 1500 }, endTimeoutMs: 15000 }));
add("n-bw-256-ticks", "A 256 kbit/s link carrying 2000 messages a second (about 700 kbit/s): where do the bytes wait, and how old is the data?", grid({ lib: "tanstack", hz: 2000, apply: "raf", span: 12, net: 1 }, [["wait", 3000]], { zero: "start", netem: { kbps: 256 } }));
add("n-bw-256-conflate", "The same link with the server conflating to one message per 50 ms.", grid({ lib: "tanstack", hz: 2000, apply: "raf", span: 12, net: 1, conflate: 50 }, [["wait", 3000]], { zero: "start", netem: { kbps: 256 } }));
add("n-bw-256-drop", "The same link; the server skips a send when its socket already holds 16 KB.", grid({ lib: "tanstack", hz: 2000, apply: "raf", span: 12, net: 1, dropAbove: 16384 }, [["wait", 3000]], { zero: "start", netem: { kbps: 256 } }));
add("n-hol-regular", "Replies of 200 KB over a 4 Mbit/s link during a drag: one reply delays everything behind it.", grid({ lib: "regular", source: "ws", net: 1, padBytes: 200_000 }, [["drag", { dy: 150, ms: 900 }], ["wait", 2500]], { netem: { kbps: 4000 } }));
add("n-jitter-ticks", "60 messages a second over a link with 80 ± 60 ms delay: do updates arrive evenly?", grid({ lib: "tanstack", hz: 60, apply: "msg", span: 12, net: 1 }, [["wait", 2500]], { zero: "start", netem: { latencyMs: 80, jitterMs: 60 } }));

// ── u: the libraries' own examples and benchmarks (lab/upstream/fetch.sh) ──
const up = (path, scroller, ready, actions, more = {}) => ({ url: "$ORIGIN/upstream/" + path, scroller, ready, actions, snapshot: false, ...L, ...more });
add("u-rt-2b-scroll", "regular-table's two_billion_rows example (2,000,000,000 × 1,000 cells, generated per draw, Intl-formatted): a steady scroll.", up("regular-table/examples/two_billion_rows/index.html", "regular-table", "regular-table tbody td", [scroll(2400), ["wait", 500]]));
add("u-rt-2b-drag", "The same example: the thumb dragged a third of the way down two billion rows.", up("regular-table/examples/two_billion_rows/index.html", "regular-table", "regular-table tbody td", [["drag", { dy: 280, ms: 900 }], ["wait", 700]]));
add("u-rt-2b-diagonal", "The same example scrolled diagonally: rows and columns change together.", up("regular-table/examples/two_billion_rows/index.html", "regular-table", "regular-table tbody td", [["gesture", { distance: 2400, xDistance: 2400, speed: 2400, source: "mouse", repeat: 1 }], ["wait", 600]]));
// regular-table's benchmark drives the table like this (benchmarks/benchmark.mjs: "Scroll Down" → benchmark.html scrollFn):
const RT_BENCH_STEP = "(async () => { const table = document.getElementById('table'); for (let i = 0; i < 60; i++) { table.scrollTop += 100; await table.draw(); } })()";
add("u-rt-bench-loop", "regular-table's own benchmark step, as its runner drives it: set scrollTop, await draw(), sixty times. What is one 'frame' here?", up("regular-table/benchmarks/benchmark.html?rows=100000&columns=1000&headerDepth=3", "regular-table", "regular-table tbody td", [["eval", RT_BENCH_STEP], ["wait", 500]], { zero: "start" }));
add("u-rt-bench-wheel", "The benchmark's page under real wheel input at about the same distance.", up("regular-table/benchmarks/benchmark.html?rows=100000&columns=1000&headerDepth=3", "regular-table", "regular-table tbody td", [scroll(6000), ["wait", 600]]));
add("u-tv-fixed-rows", "TanStack Virtual's 'fixed' example, the row list (10,000 rows of 35 px, React): a steady scroll.", up("tanstack/fixed/index.html", "div.List >> nth=0", "div.List", [scroll(2400), ["wait", 500]]));
add("u-tv-fixed-grid", "The same example's grid (10,000 × 10,000, two virtualizers on one scroller).", up("tanstack/fixed/index.html", "div.List >> nth=2", "div.List", [scroll(2400), ["wait", 500]]));
add("u-tv-dynamic-load", "TanStack's 'dynamic' example (10,000 rows of unknown height, measured as they render): the page load, which jumps to the last row.", up("tanstack/dynamic/index.html", "div.List", "div.List", [["eval", "location.reload()"], ["wait", 2500]], { zero: "start", endTimeoutMs: 8000 }));
add("u-tv-dynamic-scrollup", "The same list scrolled upward into rows never measured.", up("tanstack/dynamic/index.html", "div.List", "div.List", [["gesture", { distance: -4800, speed: 2400, source: "mouse", repeat: 1 }], ["wait", 700]], { warmMs: 2500 }));
add("u-tv-table-scroll", "TanStack's 'table' example (50,000 rows × 8 columns in a real <table>, TanStack Table, overscan 20): a steady scroll.", up("tanstack/table/index.html", "div.container", "div.container td", [scroll(2400), ["wait", 500]]));
add("u-tv-table-sort", "The same table: a click on a column header sorts 50,000 rows.", up("tanstack/table/index.html", "div.container", "div.container td", [["click", "div.container th div"], ["wait", 1500]], { endTimeoutMs: 10000 }));

// ── x: Perspective 5.9.2 (pages/psp.html) ────────────────────────────────
const psp = (query, actions, more = {}) => ({ page: "psp.html", query, actions, psp: true, viewport: { width: 1000, height: 600 }, ...more });
add("x-scroll-worker", "Perspective's datagrid, engine in a Web Worker: one scroll through viewer, regular-table, client, worker and back.", psp({ engine: "worker" }, [scroll(2400), ["wait", 600]]));
add("x-scroll-remote", "The same scroll with the table on a Node server: every window is a WebSocket round trip.", psp({ engine: "remote" }, [scroll(2400), ["wait", 600]]));
add("x-scroll-remote-lat50", "The remote table 50 ms away (100 ms round trip): what does a scroll show?", psp({ engine: "remote", net: 1 }, [scroll(2400), ["wait", 1200]], { netem: { latencyMs: 50 }, shots: true }));
for (const hz of [100, 1000]) {
  add(`x-stream-worker-${hz}`, `${hz} table.update() calls a second from the page into the worker engine: how many draws, and how many requests per draw?`, psp({ engine: "worker", hz }, [["wait", 2000]], { zero: "start" }));
  add(`x-stream-remote-${hz}`, `${hz} updates a second applied on the server: what crosses the socket per update, and what does the viewer draw?`, psp({ engine: "remote", hz }, [["wait", 2000]], { zero: "start" }));
}
add("x-stream-worker-batch", "The same 1000 rows a second as 20 updates of 50 rows.", psp({ engine: "worker", hz: 20, n: 50 }, [["wait", 2000]], { zero: "start" }));
add("x-stream-remote-lat50", "100 updates a second on the server, 50 ms away: draws now wait on round trips.", psp({ engine: "remote", hz: 100, net: 1 }, [["wait", 2500]], { zero: "start", netem: { latencyMs: 50 } }));
add("x-sort-worker", "Sorting 100,000 rows by a click's worth of configuration: where does the work run?", psp({ engine: "worker" }, [["eval", "void window.__lab.restore({ sort: [['price', 'desc']] })"], ["wait", 1500]], { zero: "start" }));
add("x-group-worker", "Grouping by region with the engine in the worker.", psp({ engine: "worker" }, [["eval", "void window.__lab.restore({ group_by: ['region'] })"], ["wait", 1500]], { zero: "start" }));
add("x-sort-remote", "The same sort on the server.", psp({ engine: "remote" }, [["eval", "void window.__lab.restore({ sort: [['price', 'desc']] })"], ["wait", 1500]], { zero: "start" }));
add("x-scroll-stream-worker", "Scrolling while 500 updates a second arrive in the worker.", psp({ engine: "worker", hz: 500, span: 5000 }, [["wait", 300], scroll(2400), ["wait", 600]]));

// The rendering module's traces also record Blink's internal category (style, layout and text-shaping detail).
for (const s of S) if (s.id.startsWith("r-") && !s.id.startsWith("r-wheel")) s.categories = [...(s.categories ?? []), "blink"];

// Scenarios added by a module's own file in ./extra/ (same shape; each exports a list).
import { readdirSync } from "node:fs";
for (const f of readdirSync(new URL("./extra/", import.meta.url)).filter((f) => f.endsWith(".mjs")).sort()) {
  const { scenarios } = await import(`./extra/${f}`);
  for (const s of scenarios) S.push({ module: s.id.split("-")[0], page: "grid.html", ...s });
}

export const SCENARIOS = S;
