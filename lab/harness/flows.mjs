// Flow arrows for WebSocket requests: page send → backend query → page reply.
// Perfetto draws a flow as an arrow between the slices that enclose its steps,
// so one request can be followed across the two processes by eye.
//
// record.mjs adds them to every new trace. Run this file to add them to saved
// traces that lack them:
//
//   node harness/flows.mjs            # every trace in ../traces with ws requests and no flows yet

import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const MARK = "app: ws request #";
const TRIP = "app: ws round trip #";

/** Append flow events to `ev`; returns how many requests got an arrow. */
export function addRpcFlows(ev) {
  const marks = ev.filter((e) => e.cat === "blink.user_timing" && e.name.startsWith(MARK) && e.ph !== "e" && e.ph !== "b");
  if (!marks.length) return 0;
  const { pid, tid } = marks[0];
  const queries = new Map(ev.filter((e) => e.cat === "backend" && e.ph === "X" && e.name.startsWith("query #")).map((e) => [e.name.slice(7), e]));
  const ends = new Map(ev.filter((e) => e.cat === "blink.user_timing" && e.ph === "e" && e.name.startsWith(TRIP)).map((e) => [e.name.slice(TRIP.length), e]));
  let n = 0;
  for (const m of marks) {
    const id = m.name.slice(MARK.length);
    const q = queries.get(id);
    const end = ends.get(id);
    if (!q || !end) continue;
    const base = { cat: "rpc", name: "ws rpc", id: "rpc" + id };
    ev.push({ ...base, ph: "s", pid, tid, ts: m.ts });
    ev.push({ ...base, ph: "t", pid: q.pid, tid: q.tid, ts: q.ts + 1 });
    ev.push({ ...base, ph: "f", bp: "e", pid, tid, ts: end.ts - 1 });
    n++;
  }
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = fileURLToPath(new URL("../../traces/", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
    const trace = JSON.parse(gunzipSync(readFileSync(dir + f)));
    if (trace.traceEvents.some((e) => e.cat === "rpc")) continue;
    const n = addRpcFlows(trace.traceEvents);
    if (!n) continue;
    writeFileSync(dir + f + ".tmp", gzipSync(JSON.stringify(trace), { level: 9 }));
    renameSync(dir + f + ".tmp", dir + f);
    console.log(f, "+", n, "flows");
  }
}
