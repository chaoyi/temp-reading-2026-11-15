// The lab page: read the configuration from the URL, mount one table, start
// the tick stream if asked, and expose window.__lab for the harness.

import "./style.css";
import { config } from "./config";
import { formatted } from "./format";
import type { Panel } from "./panel";
import { type Source, localSource, wsSource } from "./source";
import { setRate, startTicks, tickStats } from "./ticks";
import { mark, measure } from "./timing";

document.documentElement.style.setProperty("--w", `${config.width}px`);
document.documentElement.style.setProperty("--h", `${config.height}px`);
if (config.paint === "heavy") document.documentElement.classList.add("heavy-paint");
if (config.contain) document.documentElement.classList.add("contain");
if (config.bare) document.documentElement.classList.add("bare");

const host = document.getElementById("tables")!;
const status = document.getElementById("status")!;
let panel: Panel;
let source: Source;

async function start() {
  source = config.source === "ws" ? await wsSource() : localSource();
  if (config.lib === "regular") panel = await (await import("./regular")).mountRegularTable(host, source);
  else if (config.lib === "react") panel = (await import("./react")).mountReact(host, source);
  else panel = (await import("./tanstack")).mountTanstack(host, source);

  // wheel=blocking: a wheel listener that is not passive. The browser must
  // ask the main thread before it may scroll, on every wheel event.
  if (config.wheelListener !== "none")
    panel.scroller.addEventListener("wheel", function onWheel() { mark("app: wheel listener"); }, { passive: config.wheelListener === "passive" });

  startTicks((cells) => panel.update(cells));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  document.documentElement.dataset.ready = "true";
  status.textContent = `${config.lib} · ${config.rows.toLocaleString()} rows × ${config.cols} columns · source ${config.source}` + (config.tickHz ? ` · ${config.tickHz} tick messages/s × ${config.tickN} cells, apply=${config.apply}` : "");
}

/** `ms` of busy JavaScript in one task, starting with the next task. */
function longTask(ms: number) {
  setTimeout(function longTask() {
    const start = performance.now();
    while (performance.now() < start + ms) {
      // unrelated work
    }
    measure("app: long task", { start });
  }, 0);
}

/** Background load: a `forMs` task every `everyMs`, until stopped. */
let jankTimer = 0;
function jank(everyMs: number, forMs: number) {
  clearInterval(jankTimer);
  if (everyMs > 0)
    jankTimer = window.setInterval(function backgroundWork() {
      const start = performance.now();
      while (performance.now() < start + forMs) {
        // unrelated work
      }
      measure("app: background work", { start });
    }, everyMs);
}

/** Scroll by writing scrollTop once per animation frame, as the libraries' own benchmarks do. */
function programScroll(pxPerFrame: number, frames: number) {
  return new Promise<void>((done) => {
    let n = 0;
    const step = () => {
      panel.scroller.scrollTop += pxPerFrame;
      if (++n < frames) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
}

function snapshot() {
  return {
    config,
    formatted,
    scrollTop: panel.scroller.scrollTop,
    scrollLeft: panel.scroller.scrollLeft,
    firstShown: panel.firstShown(),
    rowsInDom: panel.rowsInDom(),
    cellsInDom: panel.cellsInDom(),
    counters: panel.counters(),
    source: source.stats,
    ticks: { ...tickStats },
    isolated: crossOriginIsolated,
  };
}

Object.assign(window, { __lab: { config, snapshot, longTask, jank, programScroll, setRate, panel: () => panel } });
start().catch((e) => {
  status.textContent = `Could not start: ${e instanceof Error ? e.message : e}`;
  console.error(e);
});
