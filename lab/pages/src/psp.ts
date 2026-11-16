// Perspective 5.9.2: <perspective-viewer> with the datagrid plugin, which
// draws through its own bundled regular-table.
//
//   engine=worker (default)  the engine (WebAssembly) runs in a Web Worker in
//                            this page; every view call is a postMessage
//                            round trip.
//   engine=remote            the table lives in the lab's Node process
//                            (server/psp.mjs); every view call is a WebSocket
//                            round trip. net=1 routes it through the netem
//                            proxy.
//
// hz=N&n=M starts an update stream of N update() calls a second, M rows each,
// over the first `span` rows: from this page's main thread in worker mode
// (as Perspective's trading-terminal example does), from the server in
// remote mode.
//
// The page hooks the datagrid's regular-table with a style listener, so each
// draw leaves an "app: psp draw" mark, and "app: content complete" when the
// rows drawn match the scroll position.

import perspective from "@perspective-dev/client";
import perspective_viewer from "@perspective-dev/viewer";
import "@perspective-dev/viewer-datagrid";
import "@perspective-dev/viewer/dist/css/themes.css";
import SERVER_WASM from "@perspective-dev/server/dist/wasm/perspective-server.wasm?url";
import CLIENT_WASM from "@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm?url";
import { columnKind, columnName, value } from "./rows.js";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && q.get(k) !== "" ? Number(q.get(k)) : d);
const config = {
  engine: q.get("engine") === "remote" ? "remote" : "worker",
  rows: num("rows", 100_000),
  cols: num("cols", 6),
  hz: num("hz", 0),
  n: num("n", 1),
  span: num("span", 12),
  net: q.get("net") === "1",
  throttle: q.has("throttle") ? num("throttle", 0) : undefined,
  sort: q.get("sort"), // a column name: start sorted by it, descending
  group: q.get("group"), // a column name: start grouped by it
};
const status = document.getElementById("status")!;
const counters = { draws: 0, updatesSent: 0 };

function columns(y0: number, y1: number) {
  const out: Record<string, (number | string)[]> = {};
  for (let c = 0; c < config.cols; c++) {
    const col = new Array(y1 - y0);
    for (let r = y0; r < y1; r++) col[r - y0] = value(r, c);
    out[columnName(c)] = col;
  }
  return out;
}

async function start() {
  await perspective_viewer.init({ server: fetch(SERVER_WASM), viewer: fetch(CLIENT_WASM) });
  const viewer = document.createElement("perspective-viewer") as any;
  document.body.append(viewer);
  let table: any;
  if (config.engine === "remote") {
    const env = (window as any).__LAB_ENV ?? {};
    const client = await perspective.websocket(`ws://${location.hostname}:${config.net ? env.netemPort : location.port}/ws/psp`);
    table = await client.open_table("lab");
  } else {
    const worker = await perspective.worker();
    const t0 = performance.now();
    table = await worker.table(columns(0, config.rows), { index: "row" });
    performance.measure("app: psp create table", { start: t0 });
  }
  await viewer.load(table);
  const restore: Record<string, unknown> = { plugin: "Datagrid", settings: false };
  if (config.sort) restore.sort = [[config.sort, "desc"]];
  if (config.group) restore.group_by = [config.group];
  await viewer.restore(restore);
  if (config.throttle !== undefined) viewer.setThrottle?.(config.throttle);

  // The datagrid's regular-table (inside the plugin's shadow root).
  const plugin = viewer.querySelector("perspective-viewer-datagrid") as any;
  const rt: any = plugin?.regular_table ?? plugin?.shadowRoot?.querySelector("regular-table") ?? viewer.querySelector("regular-table");
  let scrollTop = 0;
  let complete = -1;
  rt.addEventListener("scroll", () => void (scrollTop = rt.scrollTop), { passive: true });
  rt.addStyleListener(() => {
    counters.draws++;
    const td = rt.querySelector("tbody td");
    const meta = td && rt.getMeta(td);
    performance.mark("app: psp draw", { detail: { y0: meta?.y0, first: meta?.y } });
    if (meta && meta.y !== complete && meta.y === meta.y0) {
      complete = meta.y;
      performance.mark("app: content complete", { detail: { lib: "perspective", first: meta.y, scrollTop } });
    }
  });

  // The update stream.
  // The server's stream is process-wide: always set it, so a rate left over from an earlier page is cleared.
  if (config.engine === "remote") await fetch(`/__psp?hz=${config.hz}&n=${config.n}&span=${config.span}`);
  if (config.hz && config.engine === "worker") {
    const numeric: number[] = [];
    for (let c = 0; c < config.cols; c++) if (columnKind(c) === "price") numeric.push(c);
    let s = 7;
    const random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const since = performance.now();
    let made = 0;
    setInterval(function produceUpdates() {
      const due = Math.floor(((performance.now() - since) / 1000) * config.hz);
      while (made < due) {
        made++;
        const t0 = performance.now();
        const c = columnName(numeric[Math.floor(random() * numeric.length)]);
        const batch: Record<string, number[]> = { row: [], [c]: [] };
        for (let i = 0; i < config.n; i++) {
          batch.row.push(Math.floor(random() * config.span));
          batch[c].push(Math.round((random() - 0.5) * 200000) / 100);
        }
        void table.update(batch);
        counters.updatesSent++;
        performance.measure("app: psp table.update", { start: t0, detail: { seq: made } });
      }
    }, 1);
  }

  Object.assign(window, {
    __lab: {
      config,
      viewer,
      table,
      regularTable: rt,
      snapshot: () => ({ config, counters: { ...counters }, scrollTop: rt.scrollTop, rowsInDom: rt.querySelectorAll("tbody tr").length, cellsInDom: rt.querySelectorAll("tbody td").length, isolated: crossOriginIsolated }),
      restore: (cfg: object) => viewer.restore(cfg),
      stats: () => viewer.getRenderStats?.(),
    },
  });
  rt.classList.add("scroller");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  document.documentElement.dataset.ready = "true";
  status.textContent = `Perspective 5.9.2 · engine ${config.engine} · ${config.rows.toLocaleString()} × ${config.cols}` + (config.hz ? ` · ${config.hz} updates/s × ${config.n} rows` : "");
}
start().catch((e) => {
  status.textContent = "Could not start: " + (e?.message ?? e);
  console.error(e);
});
