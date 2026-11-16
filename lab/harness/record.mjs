#!/usr/bin/env node
// Record Chrome traces for the scenarios in scenarios.mjs.
//
//   node harness/record.mjs                 # every scenario
//   node harness/record.mjs m3-             # scenarios whose id starts with this
//   node harness/record.mjs --list
//   node harness/record.mjs m3- --headed    # a visible window (GPU raster, real display)
//   node harness/record.mjs m3- --runs 5    # repeat; keeps the first trace, all metrics
//
// For each scenario: open the page, start tracing, mark "trace: start", play
// the scenario's actions (real input events through the DevTools protocol),
// mark "trace: end", stop tracing. The backend's own spans are appended to the
// trace, so one file shows browser and backend on one clock. The trace is
// written gzipped to ../traces/<id>.json.gz (DevTools and ui.perfetto.dev open
// it as is), and its analysis to ../data/<id>.js.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { analyze } from "./analyze-lib.mjs";
import { addRpcFlows } from "./flows.mjs";
import { LAB, launch, startServer, startTrace } from "./browser.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const REPO = LAB + "../";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, d) => (argv.includes("--" + name) ? argv[argv.indexOf("--" + name) + 1] : d);
const prefixes = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--runs", "--out"].includes(argv[i - 1])));
const selected = SCENARIOS.filter((s) => !prefixes.length || prefixes.some((p) => s.id.startsWith(p)));

if (flag("list")) {
  for (const s of selected) console.log(s.id.padEnd(34), s.asks ?? "");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DSF = 1.75; // the operator's display; see walkthrough 1, step 21

/** Metadata kept in a published trace. The rest (machine details, net constants) is dropped. */
const KEEP_META = ["clock-domain", "cpu-num-cores", "os-arch", "os-version", "revision", "user-agent", "trace-capture-datetime"];

async function run(browser, srv, s) {
  const viewport = s.viewport ?? { width: 700, height: 400 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: s.dsf ?? DSF });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await srv.netem(s.netem ?? {});
  // A clinic case (s.hidden) keeps its knobs out of the URL and out of the trace's metadata.
  if (s.hidden) await page.addInitScript((q) => sessionStorage.setItem("lab-case", q), String(new URLSearchParams({ bare: "", ...(s.query ?? {}) })));
  const url = s.hidden ? `${srv.origin}/${s.page ?? "grid.html"}?case=${s.id.split("-")[1]}` : (s.url ?? `${srv.origin}/${s.page ?? "grid.html"}?${new URLSearchParams({ bare: "", ...(s.query ?? {}) })}`);
  await page.goto(url.replace("$ORIGIN", srv.origin));
  await page.waitForSelector(s.ready ?? 'html[data-ready="true"]', { timeout: 60_000 });
  await page.waitForTimeout(s.warmMs ?? 600); // first render, fonts, JIT warm-up of the mount path
  if (s.setup) await page.evaluate(s.setup);

  // Geometry, asked before tracing: these run layout in the page.
  const scroller = page.locator(s.scroller ?? ".scroller").first();
  const box = await scroller.boundingBox();
  const at = {
    x: box.x + Math.min(200, box.width / 2), y: box.y + Math.min(150, box.height / 2),
    bar: box.x + box.width - 7, track: box.y + box.height - 40, thumb: box.y + 21,
  };
  const first = s.actions?.find((a) => ["wheel", "gesture", "click-track", "drag", "keys"].includes(a[0]))?.[0];
  if (first === "keys") await scroller.focus();
  await page.mouse.move(first === "click-track" ? at.bar : first === "drag" ? at.bar : at.x, first === "click-track" ? at.track : first === "drag" ? at.thumb : at.y);
  if (s.cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: s.cpu });
  await page.waitForTimeout(150);

  const stop = await startTrace(browser, { screenshots: !!s.shots, more: s.categories ?? [], only: s.onlyCategories ?? null });
  await page.waitForTimeout(250);
  await srv.spans(); // drop backend events from before the trace
  await page.evaluate((id) => performance.mark("trace: start " + id), s.id);

  // Input goes through the DevTools protocol's Input domain: the browser
  // process dispatches it as it would a real device event. Mouse events are
  // sent without waiting for the page's acknowledgement, so a busy main
  // thread does not slow the "hand".
  const pending = [];
  const fire = (method, params) => pending.push(cdp.send(method, params).catch(() => {}));
  const mouse = (type, x, y, extra = {}) => fire("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });
  for (const [kind, a = {}] of s.actions ?? []) {
    switch (kind) {
      case "wait":
        await sleep(a);
        break;
      case "eval":
        await page.evaluate(a);
        break;
      case "evalNoWait": // for calls that block the main thread
        void page.evaluate(a).catch(() => {});
        await sleep(20);
        break;
      case "wheel": // n notches of dy pixels, one every `every` ms
        for (let i = 0; i < (a.n ?? 1); i++) {
          mouse("mouseWheel", at.x, at.y, { deltaX: a.dx ?? 0, deltaY: a.dy ?? 100 });
          if (i + 1 < (a.n ?? 1)) await sleep(a.every ?? 16);
        }
        break;
      case "gesture": // a scroll gesture at a constant speed (px/s), synthesized by the browser; `repeat: 1` plays it a second time
        await cdp.send("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: -(a.distance ?? 2000), xDistance: -(a.xDistance ?? 0), speed: a.speed ?? 2000, gestureSourceType: a.source ?? "touch", repeatCount: a.repeat ?? 0, repeatDelayMs: a.repeatDelayMs ?? 0 });
        break;
      case "click-track":
        mouse("mousePressed", at.bar, at.track, { button: "left", clickCount: 1 });
        mouse("mouseReleased", at.bar, at.track, { button: "left", clickCount: 1 });
        break;
      case "drag": {
        // The thumb down `dy` px over `ms`, in `steps` moves.
        const steps = a.steps ?? 30;
        mouse("mousePressed", at.bar, at.thumb, { button: "left", clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          await sleep((a.ms ?? 500) / steps);
          mouse("mouseMoved", at.bar, at.thumb + ((a.dy ?? 150) * i) / steps, { button: "left", buttons: 1 });
        }
        if (a.hold) await sleep(a.hold);
        mouse("mouseReleased", at.bar, at.thumb + (a.dy ?? 150), { button: "left", clickCount: 1 });
        break;
      }
      case "keys": // a key pressed n times, every `every` ms
        for (let i = 0; i < (a.n ?? 1); i++) {
          fire("Input.dispatchKeyEvent", { type: "rawKeyDown", key: a.key ?? "PageDown", code: a.key ?? "PageDown", windowsVirtualKeyCode: a.vk ?? 34 });
          fire("Input.dispatchKeyEvent", { type: "keyUp", key: a.key ?? "PageDown", code: a.key ?? "PageDown", windowsVirtualKeyCode: a.vk ?? 34 });
          if (i + 1 < (a.n ?? 1)) await sleep(a.every ?? 100);
        }
        break;
      case "click": {
        const b = await page.locator(a).first().boundingBox();
        mouse("mousePressed", b.x + b.width / 2, b.y + b.height / 2, { button: "left", clickCount: 1 });
        mouse("mouseReleased", b.x + b.width / 2, b.y + b.height / 2, { button: "left", clickCount: 1 });
        break;
      }
      case "netem":
        await srv.netem(a);
        break;
      case "cpu":
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: a });
        break;
      default:
        throw new Error("unknown action " + kind);
    }
  }
  await Promise.race([Promise.all(pending), sleep(3000)]);
  // The end mark waits for the main thread; a scenario that leaves it
  // saturated ends by time instead.
  const ended = await Promise.race([page.evaluate(() => (performance.mark("trace: end"), true)), sleep(s.endTimeoutMs ?? 4000).then(() => false)]);
  const { trace, dataLossOccurred, categories } = await stop();
  const spans = await srv.spans();
  if (s.cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
  const state = s.snapshot === false ? null : await Promise.race([page.evaluate(() => window.__lab?.snapshot?.() ?? null), sleep(3000).then(() => null)]);
  await context.close();

  // One file: Chrome's events, then the backend's.
  if (spans.events.length > 12) trace.traceEvents.push(...spans.events);
  addRpcFlows(trace.traceEvents);
  trace.metadata = {
    ...Object.fromEntries(KEEP_META.filter((k) => k in (trace.metadata ?? {})).map((k) => [k, trace.metadata[k]])),
    lab: s.hidden ? { scenario: s.id, asks: s.asks, note: "a clinic case: the configuration is in clinic.html" } : { scenario: s.id, asks: s.asks, query: s.query ?? null, url: s.url ?? null, actions: JSON.stringify(s.actions?.map(([k, a]) => [k, typeof a === "function" ? "(function)" : a])), dsf: s.dsf ?? DSF, viewport, cpuThrottle: s.cpu ?? 1, netem: s.netem ?? null, headed: flag("headed"), categories, dataLossOccurred, backendEventsDropped: spans.dropped, endMarked: ended },
  };
  const analysis = analyze(trace, s);
  return { trace, analysis, state, errors, dataLossOccurred };
}

mkdirSync(REPO + "traces", { recursive: true });
mkdirSync(REPO + "data", { recursive: true });
const runs = Number(opt("runs", 1));
const needsPsp = selected.some((s) => s.psp);
const srv = await startServer({ psp: needsPsp });
const browser = await launch({ headed: flag("headed") });
try {
  for (const s of selected) {
    const all = [];
    const n = s.runs ?? runs;
    for (let i = 0; i < n; i++) {
      let r;
      try {
        r = await run(browser, srv, s);
      } catch (e) {
        console.error(`${s.id}: FAILED ${String(e).slice(0, 300)}`);
        break;
      }
      all.push(r.analysis.metrics);
      if (i === 0) {
        const json = JSON.stringify(r.trace);
        const gz = gzipSync(json, { level: 9 });
        writeFileSync(`${REPO}traces/${s.id}.json.gz`, gz);
        const record = { id: s.id, asks: s.asks, module: s.module, query: s.hidden ? null : (s.query ?? null), url: s.url ?? null, actions: s.hidden ? null : r.trace.metadata.lab.actions, cpu: s.hidden ? null : (s.cpu ?? 1), netem: s.hidden ? null : (s.netem ?? null), dsf: s.dsf ?? DSF, traceBytes: gz.length, events: r.trace.traceEvents.length, recorded: new Date().toISOString(), state: s.hidden ? null : r.state, errors: r.errors, ...r.analysis };
        writeFileSync(`${REPO}data/${s.id}.js`, `(window.TRACE_DATA ??= {})[${JSON.stringify(s.id)}] = ${JSON.stringify(record)};\n`);
        const m = r.analysis.metrics;
        console.log(
          `${s.id.padEnd(34)} ${(gz.length / 1e6).toFixed(1).padStart(5)} MB  frames all/partial/dropped/none ${m.frames.all}/${m.frames.partial}/${m.frames.dropped}/${m.frames.noUpdate}` +
            `  main ${m.threads.mainUtilPct}% js ${m.main.scriptMs} lay ${Math.round(m.main.styleMs + m.main.layoutMs)} long ${m.main.longTasks}` +
            (r.errors.length ? `  ERRORS ${r.errors[0]}` : "") + (r.dataLossOccurred ? "  DATA LOSS" : ""),
        );
      }
    }
    if (all.length > 1) appendFileSync(`${REPO}data/runs.jsonl`, JSON.stringify({ id: s.id, at: new Date().toISOString(), runs: all }) + "\n");
  }
} finally {
  await browser.close();
  srv.stop();
}
