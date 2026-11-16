#!/usr/bin/env node
// Re-analyze saved traces: ../traces/<id>.json.gz → ../data/<id>.js, and
// ../data/index.js with every scenario's metrics (small; the course pages
// load it for tables and bold numbers).
//
//   node harness/analyze.mjs            # rebuild data/index.js from data/*.js
//   node harness/analyze.mjs --traces   # re-run the analysis on every saved trace first
//   node harness/analyze.mjs --print f- # print a metrics table for ids starting with f-

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { analyze } from "./analyze-lib.mjs";
import { LAB } from "./browser.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const REPO = LAB + "../";
const argv = process.argv.slice(2);
const load = (id) => {
  const text = readFileSync(`${REPO}data/${id}.js`, "utf8");
  return JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
};
if (argv.includes("--traces")) {
  for (const f of readdirSync(REPO + "traces").filter((f) => f.endsWith(".json.gz"))) {
    const id = f.replace(".json.gz", "");
    const s = SCENARIOS.find((s) => s.id === id) ?? {};
    const only = argv.find((a) => !a.startsWith("--"));
    if (only && !id.startsWith(only)) continue;
    const trace = JSON.parse(gunzipSync(readFileSync(`${REPO}traces/${f}`)));
    const prev = existsSync(`${REPO}data/${id}.js`) ? load(id) : {};
    const record = { ...prev, ...analyze(trace, s) };
    writeFileSync(`${REPO}data/${id}.js`, `(window.TRACE_DATA ??= {})[${JSON.stringify(id)}] = ${JSON.stringify(record)};\n`);
    console.log("analyzed", id);
  }
}
const index = {};
const order = new Map(SCENARIOS.map((s, i) => [s.id, i]));
for (const f of readdirSync(REPO + "data").filter((f) => f.endsWith(".js") && f !== "index.js").sort((a, b) => (order.get(a.slice(0, -3)) ?? 1e9) - (order.get(b.slice(0, -3)) ?? 1e9))) {
  const d = load(f.replace(".js", ""));
  index[d.id] = { id: d.id, asks: d.asks, module: d.module, query: d.query, url: d.url, actions: d.actions, cpu: d.cpu, netem: d.netem, dsf: d.dsf, traceBytes: d.traceBytes, recorded: d.recorded, state: d.state && { counters: d.state.counters, source: d.state.source, ticks: d.state.ticks, formatted: d.state.formatted, rowsInDom: d.state.rowsInDom, cellsInDom: d.state.cellsInDom }, metrics: d.metrics, profile: { self: d.profile?.self?.slice(0, 12), total: d.profile?.total?.slice(0, 24) } };
}
if (existsSync(REPO + "data/runs.jsonl")) {
  const runs = {};
  for (const line of readFileSync(REPO + "data/runs.jsonl", "utf8").trim().split("\n")) {
    const r = JSON.parse(line);
    runs[r.id] = r.runs; // the latest set per id
  }
  index.__runs = runs;
}
writeFileSync(REPO + "data/index.js", "window.TRACE_INDEX = " + JSON.stringify(index) + ";\n");
console.log(`data/index.js: ${Object.keys(index).length} scenarios`);

const p = argv.indexOf("--print");
if (p >= 0) {
  const prefix = argv[p + 1] ?? "";
  for (const d of Object.values(index)) {
    if (!d.id?.startsWith(prefix)) continue;
    const m = d.metrics;
    console.log(
      `${d.id.padEnd(30)} fr ${m.frames.all}/${m.frames.partial}/${m.frames.dropped}/${m.frames.noUpdate} util ${String(m.threads.mainUtilPct).padStart(5)}% js ${String(m.main.scriptMs).padStart(7)} style ${String(m.main.styleMs).padStart(6)} layout ${String(m.main.layoutMs).padStart(6)} paint ${String(m.main.paintMs).padStart(6)} gc ${m.main.gcMs} long ${m.main.longTasks}/${m.main.maxTaskMs} forced ${m.main.forcedLayouts} raster ${m.raster.ms} px/s ${m.content.pxPerSec ?? "-"}`,
    );
  }
}
