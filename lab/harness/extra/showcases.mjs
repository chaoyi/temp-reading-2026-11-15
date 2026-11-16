// Extra scenarios for Module 10 (showcases.html): the libraries' own benchmarks, driven the
// way their runners drive them. The shape is that of the up(...) entries in ../scenarios.mjs.

const L = { viewport: { width: 1640, height: 860 } };
const up = (path, scroller, ready, actions, more = {}) => ({ url: "$ORIGIN/upstream/" + path, scroller, ready, actions, snapshot: false, ...L, ...more });
const RT_BENCH = "regular-table/benchmarks/benchmark.html?rows=100000&columns=1000&headerDepth=3";

// regular-table's runner (benchmarks/benchmark.mjs:125-129, 346-350) times one
// `await page.evaluate((px) => window.scrollDown(px), 100)` per iteration: a DevTools-protocol
// round trip around benchmark.html:236-239 (`table.scrollTop += pixels; await table.draw()`).
// Each action below is one such round trip. The wrapper adds one performance.measure per
// step ("app: bench step", from the call to the resolved draw), which the runner does not have.
const RT_STEP = "(async () => { const t = performance.now(); await window.scrollDown(100); performance.measure('app: bench step', { start: t }); })()";

// A second requestAnimationFrame chain that turns every gap between two rAF timestamps into a
// measure. This is what "frames per second" from a rAF counter is made of.
const RAF_GAPS = "window.__gaps = true; requestAnimationFrame(function first(t0) { let last = t0; requestAnimationFrame(function gap(t) { performance.measure('app: bench rAF gap', { start: last, end: t }); last = t; if (window.__gaps) requestAnimationFrame(gap); }); });";

// The runner's fifth test, "Continuous Scroll" (benchmark.mjs:200-225), copied as written.
const RT_CONTINUOUS = `(() => { ${RAF_GAPS}
  window._benchmarkFrameCount = 0;
  window._benchmarkRunning = true;
  const table = document.getElementById("table");
  function scroll() {
    if (!window._benchmarkRunning) return;
    table.scrollLeft += 10;
    table.scrollTop += 20;
    if (table.scrollLeft >= table.scrollWidth - table.offsetWidth) { table.scrollLeft = 0; }
    if (table.scrollTop >= table.scrollHeight - table.offsetHeight) { table.scrollTop = 0; }
    window._benchmarkFrameCount++;
    requestAnimationFrame(scroll);
  }
  requestAnimationFrame(scroll);
})()`;
const RT_CONTINUOUS_STOP = "(() => { window._benchmarkRunning = false; window.__gaps = false; performance.mark('app: bench result', { detail: { frameCount: window._benchmarkFrameCount, tableFps: document.getElementById('table').getDrawFPS() } }); })()";

// TanStack Virtual's harness (benchmarks/src/lib/harness.ts:82-120, measureScrollFps), copied:
// one scrollTop write per animation frame, linear in elapsed time, for 1.5 s to the bottom;
// "fps" is 1000 / the mean gap between rAF timestamps. Added here: a measure per gap, and after
// each write a mark saying whether the rows in the DOM cover the position just written
// (what the frame about to be painted will show).
const TV_DRIVE = `(async () => {
  const el = document.querySelector("div.List");
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const frames = [];
  let lastT = performance.now();
  let stop = false;
  const onFrame = (t) => {
    frames.push(t - lastT);
    performance.measure("app: bench rAF gap", { start: lastT, end: t });
    lastT = t;
    if (!stop) requestAnimationFrame(onFrame);
  };
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(onFrame); });
  const startOffset = 0, targetOffset = el.scrollHeight - el.clientHeight, durationMs = 1500;
  const startT = performance.now();
  while (performance.now() - startT < durationMs) {
    const elapsed = performance.now() - startT;
    const t = Math.min(elapsed / durationMs, 1);
    el.scrollTop = startOffset + (targetOffset - startOffset) * t;
    const rows = [...el.firstElementChild.children].map((r) => Number(r.textContent.slice(4)));
    const want = Math.floor(el.scrollTop / 35);
    const covered = rows.length > 0 && Math.min(...rows) <= want && Math.max(...rows) >= want;
    performance.mark(covered ? "app: bench frame with rows" : "app: bench frame blank", { detail: { scrollTop: Math.round(el.scrollTop), wantRow: want, domRows: [Math.min(...rows), Math.max(...rows)] } });
    await nextFrame();
  }
  stop = true;
  await nextFrame();
  const longFrames = frames.filter((f) => f > 32).length;
  const jankMs = frames.filter((f) => f > 50).reduce((s, f) => s + f, 0);
  const avgFrame = frames.length ? frames.reduce((s, f) => s + f, 0) / frames.length : 0;
  performance.mark("app: bench result", { detail: { fps: avgFrame > 0 ? 1000 / avgFrame : 0, longFrames, jankMs, frames: frames.length } });
})()`;

export const scenarios = [
  { id: "u-rt-bench-steps", asks: "regular-table's benchmark as its runner really drives it: sixty separate protocol calls, each 'scrollTop += 100; await draw()'. How many frames is sixty iterations?", ...up(RT_BENCH, "regular-table", "regular-table tbody td", [...Array.from({ length: 60 }, () => ["eval", RT_STEP]), ["wait", 500]], { zero: "start" }) },
  { id: "u-rt-bench-raf", asks: "The benchmark's 'Continuous Scroll' test: scrollLeft += 10 and scrollTop += 20 in every animation frame, counted by a rAF counter.", ...up(RT_BENCH, "regular-table", "regular-table tbody td", [["eval", RT_CONTINUOUS], ["wait", 1500], ["eval", RT_CONTINUOUS_STOP], ["wait", 400]], { zero: "start" }) },
  { id: "u-tv-bench-drive", asks: "TanStack's 'fixed' row list driven as TanStack's benchmark harness drives a list: one scrollTop write per animation frame, top to bottom in 1.5 s. What does its 'scrollFps' see?", ...up("tanstack/fixed/index.html", "div.List >> nth=0", "div.List", [["eval", TV_DRIVE], ["wait", 400]], { zero: "start", shots: true }) },
  { id: "u-tv-table-sort-name", asks: "The table example sorted by a text column (First Name): 50,000 strings in random order.", ...up("tanstack/table/index.html", "div.container", "div.container td", [["click", "div.container th:nth-child(2) div"], ["wait", 1500]], { endTimeoutMs: 10000 }) },
];
