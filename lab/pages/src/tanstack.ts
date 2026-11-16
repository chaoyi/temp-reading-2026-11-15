// The table with TanStack Virtual (virtual-core, no framework).
//
// The library owns the range math and listens to the scroller; this file
// owns every element. Two Virtualizers watch one scroller: rows (vertical)
// and columns (horizontal). On a `scroll` event each recomputes its range
// and, if the range changed, calls `onChange`, which calls render() below,
// synchronously, inside the same event dispatch.
//
//   scroll event ─▶ virtual-core observeElementOffset handler
//                   ─▶ calculateRange ─▶ onChange ─▶ render() (this file)
//
// pool=keyed (default): one row element per visible row index, as a
// framework's keyed list would keep. A row that stays on screen is not
// touched; a row that enters is created and its cells formatted; a row that
// leaves is removed.
// pool=positional: a fixed set of row elements reused by screen position.
// Every render rewrites the text of every visible cell, which is how
// regular-table works. Same library, other reuse policy.

import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from "@tanstack/virtual-core";
import { config } from "./config";
import { allocateGarbage, cellClass, formatCell } from "./format";
import { type Panel, panelShell } from "./panel";
import { COL_WIDTH, ROW_HEIGHT, columnName } from "./rows.js";
import type { Cell, Source } from "./source";
import type { Update } from "./ticks";
import { mark, measure } from "./timing";

const HEADER = ROW_HEIGHT;

interface RowEl extends HTMLDivElement {
  _index: number;
  _x0: number;
  _x1: number;
  _ready: boolean;
}

export function mountTanstack(host: HTMLElement, source: Source): Panel {
  const { scroller, readout } = panelShell(host, "tanstack", `TanStack Virtual 3.19.11 · ${config.pool} pool`, document.createElement("div"));
  const head = scroller.appendChild(document.createElement("div"));
  head.className = "head";
  const sizer = scroller.appendChild(document.createElement("div"));
  sizer.className = "sizer";
  sizer.style.width = `${config.cols * COL_WIDTH}px`;
  sizer.style.height = `${config.rows * ROW_HEIGHT}px`; // fixed row height: the total is known up front
  head.style.width = `${config.cols * COL_WIDTH}px`;

  const pool = new Map<number, RowEl>(); // keyed: row index → element
  const slots: RowEl[] = []; // positional: screen slot → element
  const c = { renders: 0, rowsCreated: 0, cellsWritten: 0, patches: 0 };
  let complete = -1;
  let headX0 = -1;
  let headX1 = -1;
  const bodyHeight = config.height - HEADER; // read from config: reading layout in render() would force one

  const common = { getScrollElement: () => scroller, scrollToFn: elementScroll, observeElementRect, observeElementOffset, onChange: () => render() };
  const rowV = new Virtualizer<HTMLDivElement, HTMLDivElement>({ ...common, count: config.rows, estimateSize: () => ROW_HEIGHT, scrollMargin: HEADER, overscan: config.overscan });
  // colv=0: no second virtualizer; all columns are rendered (fine for a narrow table).
  const colV = config.colv ? new Virtualizer<HTMLDivElement, HTMLDivElement>({ ...common, count: config.cols, estimateSize: () => COL_WIDTH, horizontal: true, overscan: 1 }) : undefined;

  function writeCell(el: HTMLElement, v: Cell | undefined, col: number) {
    el.textContent = v === undefined ? "…" : formatCell(v, col);
    if (config.cls) el.className = v === undefined ? "" : cellClass(v, col);
    c.cellsWritten++;
  }

  /** Make `el` show row `index` for columns x0..x1 (inclusive). */
  function fill(el: RowEl, index: number, x0: number, x1: number, row: Cell[] | undefined) {
    const want = x1 - x0 + 1;
    while (el.children.length < want) el.appendChild(document.createElement("div"));
    while (el.children.length > want) el.lastChild!.remove();
    for (let i = 0; i < want; i++) writeCell(el.children[i] as HTMLElement, row?.[i], x0 + i);
    if (el._x0 !== x0) el.style.paddingLeft = `${x0 * COL_WIDTH}px`;
    el._index = index;
    el._x0 = x0;
    el._x1 = x1;
    el._ready = row !== undefined;
  }

  function newRow(): RowEl {
    const el = document.createElement("div") as RowEl;
    el.className = "row";
    el._index = -1;
    el._x0 = -1;
    el._x1 = -1;
    el._ready = false;
    c.rowsCreated++;
    return sizer.appendChild(el);
  }

  function renderHead(x0: number, x1: number) {
    if (x0 === headX0 && x1 === headX1) return;
    headX0 = x0;
    headX1 = x1;
    head.replaceChildren();
    head.style.paddingLeft = `${x0 * COL_WIDTH}px`;
    for (let col = x0; col <= x1; col++) head.appendChild(document.createElement("div")).textContent = columnName(col);
  }

  function render() {
    const t0 = performance.now();
    c.renders++;
    allocateGarbage();
    const rows = rowV.getVirtualItems();
    const cols = colV?.getVirtualItems();
    if (!rows.length || cols?.length === 0) return;
    const first = rows[0].index;
    const last = rows[rows.length - 1].index;
    const x0 = cols ? cols[0].index : 0;
    const x1 = cols ? cols[cols.length - 1].index : config.cols - 1;
    renderHead(x0, x1);
    source.want(first, last + 1, x0, x1 + 1);
    const data = source.peek(first, last + 1, x0, x1 + 1); // ws: asks for what is missing
    const written = c.cellsWritten;
    let entered = 0;

    if (config.pool === "keyed") {
      const seen = new Set<number>();
      for (const item of rows) {
        seen.add(item.index);
        const row = data?.[item.index - first];
        let el = pool.get(item.index);
        if (el === undefined) {
          el = newRow();
          pool.set(item.index, el);
          el.style.transform = `translateY(${item.start - HEADER}px)`;
          fill(el, item.index, x0, x1, row);
          entered++;
        } else if (el._x0 !== x0 || el._x1 !== x1 || (!el._ready && row)) fill(el, item.index, x0, x1, row);
        if (config.thrash) void el.offsetTop; // the mistake: read layout right after a write
      }
      for (const [index, el] of pool)
        if (!seen.has(index)) {
          el.remove();
          pool.delete(index);
        }
    } else {
      while (slots.length < rows.length) slots.push(newRow());
      while (slots.length > rows.length) slots.pop()!.remove();
      rows.forEach((item, i) => {
        const el = slots[i];
        const moved = el._index !== item.index;
        if (moved) {
          el.style.transform = `translateY(${item.start - HEADER}px)`;
          entered++;
        }
        const row = data?.[item.index - first];
        if (moved || el._x0 !== x0 || el._x1 !== x1 || (!el._ready && row)) fill(el, item.index, x0, x1, row);
        if (config.thrash) void el.offsetTop;
      });
    }
    if (!data) void source.get(first, last + 1, x0, x1 + 1).then(render); // render again when it arrives
    measure("app: draw", { start: t0, detail: { lib: "tanstack", first, last, x0, x1, entered, cells: c.cellsWritten - written, filled: !!data } });
    markComplete();
    if (!config.bare) readout(`scrollTop ${Math.round(rowV.scrollOffset ?? 0)} · rows in DOM ${rowsInDom()} · renders ${c.renders} · cells written ${c.cellsWritten}`);
  }

  const rowsInDom = () => (config.pool === "keyed" ? pool.size : slots.length);
  const rowEl = (index: number) => (config.pool === "keyed" ? pool.get(index) : slots.find((s) => s._index === index));

  /** Mark when every row overlapping the viewport shows its data. */
  function markComplete() {
    const top = rowV.scrollOffset ?? 0;
    const first = Math.floor(top / ROW_HEIGHT);
    const last = Math.min(config.rows - 1, Math.floor((top + bodyHeight - 1) / ROW_HEIGHT));
    for (let r = first; r <= last; r++) if (!rowEl(r)?._ready) return;
    if (first !== complete) {
      complete = first;
      mark("app: content complete", { detail: { lib: "tanstack", first, scrollTop: top } });
    }
  }

  rowV._didMount();
  rowV._willUpdate(); // attach the scroll and resize observers
  colV?._didMount();
  colV?._willUpdate();
  render();

  return {
    id: "tanstack",
    scroller,
    firstShown: () => {
      const first = Math.floor((rowV.scrollOffset ?? 0) / ROW_HEIGHT);
      return rowEl(first)?._ready ? first : -1;
    },
    rowsInDom,
    cellsInDom: () => sizer.querySelectorAll(".row > div").length,
    cellText: (row, col) => {
      const el = rowEl(row);
      return el && col >= el._x0 && col <= el._x1 ? (el.children[col - el._x0]?.textContent ?? null) : null;
    },
    // A pushed value: rewrite only that cell, if its row is on screen.
    update(cells: Update[]) {
      for (const [r, col, v] of cells) {
        const el = rowEl(r);
        if (!el || !el._ready || col < el._x0 || col > el._x1) continue;
        writeCell(el.children[col - el._x0] as HTMLElement, v, col);
        c.patches++;
      }
    },
    counters: () => ({ ...c }),
  };
}
