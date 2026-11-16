// A Perspective server in this Node process: one table, "lab", served over
// /ws/psp exactly as Perspective's own esbuild-remote example serves one
// (make_session per connection, binary protobuf frames, permessage-deflate
// on), plus spans around every request so the trace shows the engine's side.
//
// In Node the engine is the same WebAssembly build the browser's worker
// runs, on the Node main thread (perspective.node.js).

import { WebSocketServer } from "ws";
import { columnKind, columnName, value } from "../pages/src/rows.js";
import { counter, instant, nowUs, span } from "./spans.mjs";

/** Columnar rows y0..y1 of the lab table, as Perspective's `table()` accepts them. */
export function columns(y0, y1, cols) {
  const out = {};
  for (let c = 0; c < cols; c++) {
    const col = new Array(y1 - y0);
    for (let r = y0; r < y1; r++) col[r - y0] = value(r, c);
    out[columnName(c)] = col;
  }
  return out;
}

export async function perspectiveRoute({ rows = 100_000, cols = 6 } = {}) {
  const { default: perspective, make_session } = await import("@perspective-dev/client");
  const t0 = nowUs();
  const table = await perspective.table(columns(0, rows, cols), { name: "lab", index: "row" });
  span("psp", `create table (${rows} × ${cols})`, t0, nowUs() - t0);

  // The update stream: `hz` update() calls a second, `n` rows each, over the first `span` rows.
  let timer = null;
  let seq = 0;
  let s = 7;
  const random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const numeric = [];
  for (let c = 0; c < cols; c++) if (columnKind(c) === "price") numeric.push(c);
  function setRate({ hz = 0, n = 1, span: rowSpan = 12 }) {
    clearInterval(timer);
    timer = null;
    if (!hz) return;
    const since = nowUs();
    let made = 0;
    timer = setInterval(() => {
      const due = Math.floor(((nowUs() - since) / 1e6) * hz);
      while (made < due) {
        made++;
        seq++;
        const t = nowUs();
        const batch = { row: [] };
        const c = numeric[Math.floor(random() * numeric.length)];
        batch[columnName(c)] = [];
        for (let i = 0; i < n; i++) {
          batch.row.push(Math.floor(random() * rowSpan));
          batch[columnName(c)].push(Math.round((random() - 0.5) * 200000) / 100);
        }
        table.update(batch);
        span("psp", "table.update", t, nowUs() - t, { seq, rows: n });
      }
    }, 1);
  }

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  let conn = 0;
  const handle = async (ws) => {
    const id = ++conn;
    let inFlight = 0;
    const session = await make_session(async (proto) => {
      // `proto` is a view into the engine's WebAssembly memory, which the next
      // call reuses: copy it before the socket queues it (upstream's example
      // does the same with buffer_to_arraybuffer).
      ws.send(Buffer.from(proto));
      instant("io", `psp send ${proto.byteLength} B`, nowUs(), { conn: id, buffered: ws.bufferedAmount });
    });
    ws.on("message", async (data) => {
      const t = nowUs();
      inFlight++;
      counter("psp requests in flight", inFlight, t);
      const buf = new Uint8Array(data); // a copy, as upstream's example passes
      await session.handle_request(buf);
      inFlight--;
      span("psp", "handle_request", t, nowUs() - t, { bytes: data.byteLength, conn: id });
      counter("psp requests in flight", inFlight);
    });
    ws.on("close", () => session.close());
  };
  return { wss, handle, setRate };
}
