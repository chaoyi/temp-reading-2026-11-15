#!/usr/bin/env node
// Ask a saved trace questions from the terminal. Times are milliseconds on the
// same axis as the course's charts (after the first input, or after the start
// mark for scenarios without input).
//
//   node harness/q.mjs <id> summary
//   node harness/q.mjs <id> threads                       threads with event counts
//   node harness/q.mjs <id> names [thread-substring]      event names on a thread, by total time
//   node harness/q.mjs <id> slices <name-regex> [thread] [from to]   matching slices, with args
//   node harness/q.mjs <id> tree <from> <to> [thread] [minUs]        the nested slices in a window
//   node harness/q.mjs <id> prof <from> <to> [thread]     sampled JavaScript by self/total time in a window
//   node harness/q.mjs <id> stack <ms> [thread]           the sampled JavaScript stack nearest a time
//   node harness/q.mjs <id> frames [from to]              one line per vsync
//   node harness/q.mjs <id> tasks [from to] [minMs]       main-thread tasks with queue, priority, poster
//   node harness/q.mjs <id> marks [regex] [from to]       our marks and measures
//   node harness/q.mjs <id> raw <name-regex> [n]          raw JSON of the first n matching events
//
// thread defaults to the page's main thread; give a substring of a thread
// name ("Compositor", "Viz", "DedicatedWorker", "ChildIO", "ws io", …).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { analyze, open } from "./analyze-lib.mjs";
import { LAB } from "./browser.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const [id, cmd = "summary", ...args] = process.argv.slice(2);
if (!id) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
  process.exit(0);
}
const trace = JSON.parse(gunzipSync(readFileSync(`${LAB}../traces/${id}.json.gz`)));
const scenario = SCENARIOS.find((s) => s.id === id) ?? {};
const T = open(trace);
const A = analyze(trace, scenario);
const { ev, ids, threadName } = T;
const t0 = A.t0;
const ms = (ts) => (ts - t0) / 1000;
const f = (x, w = 9) => x.toFixed(2).padStart(w);
const num = (s, d) => (s === undefined || Number.isNaN(Number(s)) ? d : Number(s));

function threadKey(sub) {
  if (!sub || sub === "main") return `${ids.pid}:${ids.main}`;
  // Prefer the page's own process, then any.
  const hits = [...threadName].filter(([, n]) => n.toLowerCase().includes(sub.toLowerCase()));
  return (hits.find(([k]) => k.startsWith(ids.pid + ":")) ?? hits[0])?.[0];
}
const onKey = (key) => (e) => `${e.pid}:${e.tid}` === key;

function tree(events) {
  const xs = events.filter((e) => e.ph === "X").sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [];
  const out = [];
  for (const e of xs) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur < e.ts + (e.dur || 0)) stack.pop();
    out.push([stack.length, e]);
    stack.push(e);
  }
  return out;
}
const brief = (a) => {
  if (!a) return "";
  const s = JSON.stringify(a);
  return s.length > 2 ? " " + (s.length > 260 ? s.slice(0, 260) + "…" : s) : "";
};

switch (cmd) {
  case "summary": {
    const m = A.metrics;
    console.log(JSON.stringify({ window: [A.startMs, A.endMs], frames: m.frames, main: m.main, threads: m.threads, app: m.app, marks: m.marks, eventLatency: m.eventLatency, content: m.content, ws: m.ws, ticks: m.ticks, gc: m.gc, raster: m.raster, heap: m.heap, backend: m.backend, taskQueues: m.taskQueues }, null, 1));
    console.log("lab:", JSON.stringify(trace.metadata?.lab ?? {}));
    break;
  }
  case "threads": {
    const count = new Map();
    for (const e of ev) if (e.ph !== "M") count.set(`${e.pid}:${e.tid}`, (count.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
    for (const [k, n] of [...count].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(8), k.padEnd(18), T.processName.get(Number(k.split(":")[0])) ?? "?", "/", threadName.get(k) ?? "?");
    break;
  }
  case "names": {
    const key = threadKey(args[0]);
    const by = new Map();
    for (const e of ev.filter(onKey(key))) {
      if (e.ph === "M" || e.ts < T.startTs || e.ts > T.endTs) continue;
      const r = by.get(e.name) ?? { n: 0, us: 0, cat: e.cat, ph: new Set() };
      r.n++;
      r.us += e.dur ?? 0;
      r.ph.add(e.ph);
      by.set(e.name, r);
    }
    console.log(`thread ${threadName.get(key)} (${key})`);
    for (const [name, r] of [...by].sort((a, b) => b[1].us - a[1].us || b[1].n - a[1].n).slice(0, 80)) console.log(f(r.us / 1000), "ms", String(r.n).padStart(6), "×", [...r.ph].join(""), name, " [" + r.cat + "]");
    break;
  }
  case "slices": {
    const re = new RegExp(args[0]);
    const hasThread = args[1] !== undefined && Number.isNaN(Number(args[1]));
    const key = hasThread ? threadKey(args[1]) : null;
    const rest = hasThread ? args.slice(2) : args.slice(1);
    const [from, to] = [num(rest[0], -1e12), num(rest[1], 1e12)];
    const hits = ev.filter((e) => e.ph !== "M" && re.test(e.name) && (!key || onKey(key)(e)) && ms(e.ts) >= from && ms(e.ts) <= to).sort((a, b) => a.ts - b.ts);
    for (const e of hits.slice(0, 200)) console.log(f(ms(e.ts), 10), e.dur != null ? f(e.dur / 1000, 8) : "       " + e.ph, (threadName.get(`${e.pid}:${e.tid}`) ?? "?").padEnd(18).slice(0, 18), e.name + brief(e.args));
    console.log(`${hits.length} events` + (hits.length > 200 ? " (first 200 shown)" : "") + `, total ${f(hits.reduce((a, e) => a + (e.dur ?? 0), 0) / 1000, 0)} ms`);
    break;
  }
  case "tree": {
    const [from, to] = [Number(args[0]), Number(args[1])];
    const key = threadKey(args[2]);
    const minUs = num(args[3], 20);
    const xs = ev.filter((e) => onKey(key)(e) && e.ph === "X" && ms(e.ts + e.dur) >= from && ms(e.ts) <= to);
    console.log(`thread ${threadName.get(key)}; start ms, duration ms`);
    for (const [depth, e] of tree(xs)) if (e.dur >= minUs) console.log(f(ms(e.ts), 10), f(e.dur / 1000, 8), "  ".repeat(depth) + e.name + (["FunctionCall", "EventDispatch", "Layout", "UpdateLayoutTree", "ThreadControllerImpl::RunTask", "MinorGC", "MajorGC", "TimerFire"].includes(e.name) ? brief(e.args) : ""));
    break;
  }
  case "prof":
  case "stack": {
    const key = threadKey(cmd === "prof" ? args[2] : args[1]);
    const [pid, tid] = key.split(":").map(Number);
    const prof = ev.find((e) => e.name === "Profile" && e.pid === pid && e.tid === tid);
    if (!prof) {
      console.log("no CPU profile for this thread");
      break;
    }
    const nodes = new Map();
    let t = prof.args.data.startTime;
    const samples = [];
    for (const e of ev) {
      if (e.name !== "ProfileChunk" || e.pid !== pid || e.id !== prof.id) continue;
      for (const n of e.args.data.cpuProfile?.nodes ?? []) nodes.set(n.id, n);
      (e.args.data.cpuProfile?.samples ?? []).forEach((s, i) => samples.push([(t += e.args.data.timeDeltas[i]), s, e.args.data.timeDeltas[i]]));
    }
    const label = (n) => `${n.callFrame.functionName || "(anonymous)"}${n.callFrame.url ? " " + n.callFrame.url.replace(/^https?:\/\/[^/]+\//, "") + ":" + ((n.callFrame.lineNumber ?? 0) + 1) : ""}`;
    const chain = (id) => {
      const out = [];
      for (let n = nodes.get(id); n; n = nodes.get(n.parent)) out.push(label(n));
      return out;
    };
    if (cmd === "stack") {
      const at = Number(args[0]);
      const best = samples.reduce((a, b) => (Math.abs(ms(b[0]) - at) < Math.abs(ms(a[0]) - at) ? b : a));
      console.log(`sample at ${f(ms(best[0]), 0)} ms (leaf first):`);
      for (const l of chain(best[1])) console.log("  " + l);
      break;
    }
    const [from, to] = [Number(args[0]), Number(args[1])];
    const self = new Map(), total = new Map();
    let n = 0;
    for (const [ts, sid, dt] of samples) {
      if (ms(ts) < from || ms(ts) > to) continue;
      n++;
      const c = chain(sid);
      self.set(c[0], (self.get(c[0]) ?? 0) + dt);
      for (const l of new Set(c)) total.set(l, (total.get(l) ?? 0) + dt);
    }
    console.log(`${n} samples in [${from}, ${to}] ms on ${threadName.get(key)}`);
    console.log("— self time");
    for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(f(us / 1000), "ms", k);
    console.log("— total time (function and everything it called)");
    for (const [k, us] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(f(us / 1000), "ms", k);
    break;
  }
  case "frames": {
    const [from, to] = [num(args[0], -1e12), num(args[1], 1e12)];
    console.log("vsync ms   state    seq  scroll  missing  presented-after-ms");
    for (const [t, state, seq, scroll, missing, presented] of A.lanes.frames) if (t >= from && t <= to) console.log(f(t), state.padEnd(8), String(seq).padStart(5), (scroll || "-").padEnd(7), missing ? "MISSING" : "-      ", presented ?? "-");
    console.log("main frames (BeginMainFrame sent → commit): start ms, ms, state, seq, queue-wait ms");
    for (const [t, d, state, seq, wait] of A.lanes.mainFrames) if (t >= from && t <= to) console.log(f(t), f(d, 8), state.padEnd(8), String(seq).padStart(5), wait ?? "-");
    break;
  }
  case "tasks": {
    const [from, to, min] = [num(args[0], -1e12), num(args[1], 1e12), num(args[2], 1)];
    const key = `${ids.pid}:${ids.main}`;
    for (const e of ev.filter((e) => onKey(key)(e) && e.name === "ThreadControllerImpl::RunTask" && ms(e.ts) >= from && ms(e.ts) <= to && e.dur >= min * 1000).sort((a, b) => a.ts - b.ts).slice(0, 300)) {
      const s = e.args?.sequence_manager_task ?? {};
      console.log(f(ms(e.ts), 10), f(e.dur / 1000, 8), (s.queue_name ?? "?").padEnd(22), (s.priority ?? "").padEnd(18), s.task_type ?? "", `${e.args?.src_func ?? ""} (${(e.args?.src_file ?? "").split("/").pop()})`);
    }
    break;
  }
  case "marks": {
    const re = new RegExp(args[0] ?? ".");
    const [from, to] = [num(args[1], -1e12), num(args[2], 1e12)];
    const rows = [...A.lanes.app.map(([t, d, , label]) => [t, d, label]), ...A.lanes.marks.map(([t, , full]) => [t, null, full])].filter(([t, , l]) => re.test(l) && t >= from && t <= to).sort((a, b) => a[0] - b[0]);
    for (const [t, d, l] of rows.slice(0, 400)) console.log(f(t, 10), d == null ? "    mark" : f(d, 8), l.slice(0, 220));
    console.log(rows.length, "entries");
    break;
  }
  case "raw": {
    const re = new RegExp(args[0]);
    for (const e of ev.filter((e) => re.test(e.name) && e.ts >= T.startTs).slice(0, num(args[1], 3))) console.log(JSON.stringify(e));
    break;
  }
  default:
    console.log("unknown command", cmd);
}
