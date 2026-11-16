// The table with regular-table 0.9.2.
//
// regular-table owns the scroller, the <table> and its cells; this file owns
// the data. On each `scroll` event regular-table's passive listener
// (`_on_scroll`, src/ts/events.ts) starts a draw: it computes the visible
// rectangle, *awaits* the data listener below, and commits the cell texts in
// an animation frame. One draw is in flight at a time; a newer scroll
// position replaces a waiting one.
//
//   scroll event ─▶ regular-table _on_scroll ─▶ draw
//                   ─▶ await dataListener(x0, y0, x1, y1) (this file)
//                   ─▶ write every visible cell's text ─▶ style listeners
//
// The <table> is `position: sticky` inside the scroller: while a draw is
// pending it stays put, showing the previous rows, instead of scrolling
// away. Cells are reused by screen position, not by row.
//
// A pushed value (ticks) cannot be patched into one cell from outside, so
// update() asks regular-table for a whole draw; regular-table coalesces
// draws that are requested while one is running.

import "regular-table"; // defines <regular-table>; vite.config.mjs serves its TypeScript source
import type { RegularTableElement } from "regular-table";
import { config } from "./config";
import { allocateGarbage, cellClass, formatCell } from "./format";
import { type Panel, panelShell } from "./panel";
import { ROW_HEIGHT, columnName } from "./rows.js";
import { type Source, overlay } from "./source";
import { value } from "./rows.js";
import { mark, measure } from "./timing";

export async function mountRegularTable(host: HTMLElement, source: Source): Promise<Panel> {
  const table = document.createElement("regular-table") as RegularTableElement;
  const { readout } = panelShell(host, "regular", "regular-table 0.9.2", table);
  if (config.colw === "fixed") table.classList.add("fixed-columns");
  const c = { listenerCalls: 0, draws: 0, cellsFormatted: 0, drawRequests: 0 };
  let scrollTop = 0;
  let complete = -1;

  table.setDataListener(async (x0, y0, x1, y1) => {
    const t0 = performance.now();
    c.listenerCalls++;
    allocateGarbage();
    const rows = await source.get(y0, y1, x0, x1); // ws: waits for the backend
    const t1 = performance.now();
    // Column-major, as regular-table expects: data[column][row].
    const data: string[][] = [];
    for (let col = x0; col < x1; col++) {
      const column = new Array<string>(rows.length);
      for (let r = 0; r < rows.length; r++) column[r] = formatCell(rows[r][col - x0], col);
      data.push(column);
    }
    c.cellsFormatted += rows.length * (x1 - x0);
    const column_headers = [];
    for (let col = x0; col < x1; col++) column_headers.push([columnName(col)]);
    measure("app: data listener", {
      start: t0,
      detail: { lib: "regular", y0, y1, x0, x1, cells: rows.length * (x1 - x0), waitedMs: t1 - t0, formatMs: performance.now() - t1 },
    });
    return { num_rows: config.rows, num_columns: config.cols, column_headers, data };
  });

  // Our own passive listener, only to know where the scroller is when a draw
  // commits (reading scrollTop after the DOM changed would force a layout).
  table.addEventListener("scroll", () => {
    scrollTop = table.scrollTop;
    if (config.rtReset) table.resetAutoSize(); // forget measured column widths: the next draw measures again
  }, { passive: true });

  const body = (td: Element) => {
    const meta = table.getMeta(td as HTMLElement);
    return meta?.type === "body" ? meta : undefined;
  };
  const firstDrawn = () => {
    const td = table.querySelector("tbody td");
    return td ? (body(td)?.y ?? -1) : -1;
  };

  // Runs after every draw has written its cells: the place to style them.
  table.addStyleListener(() => {
    const t0 = performance.now();
    c.draws++;
    if (config.cls || config.thrash)
      for (const td of table.querySelectorAll("tbody td")) {
        const meta = body(td);
        if (!meta) continue;
        if (config.cls) td.className = cellClass(overlay.get(meta.y * 4096 + meta.x) ?? value(meta.y, meta.x), meta.x);
        if (config.thrash) void (td as HTMLElement).offsetWidth; // the mistake: read layout right after a write
      }
    const first = firstDrawn();
    if (first === Math.floor(scrollTop / ROW_HEIGHT) && first !== complete) {
      complete = first;
      mark("app: content complete", { detail: { lib: "regular", first, scrollTop } });
    }
    measure("app: style listener", { start: t0, detail: { draw: c.draws, first } });
    if (!config.bare) readout(`scrollTop ${Math.round(scrollTop)} · rows in DOM ${table.querySelectorAll("tbody tr").length} · draws ${c.draws} · data requests ${c.listenerCalls}`);
  });

  await table.draw();

  return {
    id: "regular",
    scroller: table,
    firstShown: () => (firstDrawn() === Math.floor(table.scrollTop / ROW_HEIGHT) ? firstDrawn() : -1),
    rowsInDom: () => table.querySelectorAll("tbody tr").length,
    cellsInDom: () => table.querySelectorAll("tbody td").length,
    cellText: (row, col) => {
      for (const td of table.querySelectorAll("tbody td")) {
        const meta = body(td);
        if (meta?.y === row && meta.x === col) return td.textContent;
      }
      return null;
    },
    update() {
      c.drawRequests++;
      void table.draw();
    },
    counters: () => ({ ...c }),
  };
}
