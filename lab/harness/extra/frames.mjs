// Extra scenarios for Module 2 (frames.html).
//
// f-cat-*      the observer-effect question asked properly: the same scroll
//              under four sets of trace categories, five runs each (the first
//              trace is kept, every run's metrics go to data/runs.jsonl).
//              scenarios.mjs' f-observer-default and f-observer-blink turned
//              out to record the same categories (the default list already
//              contains "blink"), so that pair cannot answer what Blink's
//              internal category costs. f-cat-noblink can.
// f-slow-tanstack   a TanStack table whose main frames take longer than one
//              vsync, and which never calls requestAnimationFrame: are its
//              late frames flagged in DevTools' Frames track?
// f-wheel-tanstack  thirty notches of a mouse wheel (Input.dispatchMouseEvent
//              "mouseWheel", 100 px each), instead of the synthesized
//              constant-speed gesture: which kind of scroll is that to the
//              compositor's scheduler?

import { CATEGORIES } from "../browser.mjs";

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const scroll = (speed, seconds = 1) => ["gesture", { distance: Math.round(speed * seconds), speed, source: "mouse" }];
// The categories analyze-lib.mjs needs for its frame and main-thread numbers (scenarios.mjs: DEVTOOLS_ONLY).
const MINIMAL = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "latencyInfo", "cc", "benchmark"];
const observer = { query: { lib: "regular", cols: 100, ...big }, actions: [scroll(2400), ["wait", 400]], ...L, runs: 5 };

export const scenarios = [
  { id: "f-cat-min", asks: "Five runs with only the categories the analysis needs, and no JavaScript sampling.", ...observer, onlyCategories: MINIMAL },
  { id: "f-cat-default", asks: "Five runs with this course's default categories.", ...observer },
  { id: "f-cat-noblink", asks: "Five runs with the default categories minus Blink's internal category.", ...observer, onlyCategories: CATEGORIES.filter((c) => c !== "blink") },
  { id: "f-cat-nosampling", asks: "Five runs with the default categories minus V8's sampling profiler.", ...observer, onlyCategories: CATEGORIES.filter((c) => !c.includes("cpu_profiler")) },
  { id: "f-slow-tanstack", asks: "TanStack with 2.5 ms of formatting per cell written: main frames longer than one vsync, and no requestAnimationFrame. What do the frame records and DevTools' flags say?", query: { lib: "tanstack", formatUs: 2500 }, actions: [scroll(2400), ["wait", 700]] },
  { id: "f-wheel-tanstack", asks: "Thirty notches of a mouse wheel, one every 33 ms: how does the scheduler treat a wheel that the compositor animates?", query: { lib: "tanstack" }, actions: [["wheel", { n: 30, every: 33 }], ["wait", 700]] },
];
