// The table with @tanstack/react-virtual 3.14.26 and React 19: the same range
// math as tanstack.ts, with React owning the elements.
//
//   scroll event ─▶ virtual-core handler ─▶ onChange (the adapter)
//                   ─▶ flushSync(rerender) ─▶ Grid() ─▶ Row() × visible rows
//                   ─▶ React commits the DOM changes
//
// React's keyed list gives the same reuse policy as the keyed pool: a row
// that stays keeps its elements. What React adds is the render itself: the
// Grid function and, unless rows are memoized (memo=1), every Row function
// run again on every range change, and the result is diffed.

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useLayoutEffect, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";
import { config } from "./config";
import { allocateGarbage, cellClass, formatCell } from "./format";
import { type Panel, panelShell } from "./panel";
import { COL_WIDTH, ROW_HEIGHT, columnName } from "./rows.js";
import type { Cell, Source } from "./source";
import { mark, measure } from "./timing";

const HEADER = ROW_HEIGHT;
const c = { renders: 0, rowRenders: 0, cellsFormatted: 0, commits: 0 };
const rowVersion = new Map<number, number>(); // bumped when a pushed value lands in a row

interface RowProps { index: number; start: number; x0: number; x1: number; data: Cell[] | undefined; version: number }
function RowImpl({ index, start, x0, x1, data }: RowProps) {
  c.rowRenders++;
  const cells = [];
  for (let col = x0; col <= x1; col++) {
    const v = data?.[col - x0];
    if (v !== undefined) c.cellsFormatted++;
    cells.push(
      <div key={col} className={config.cls && v !== undefined ? cellClass(v, col) : undefined}>
        {v === undefined ? "…" : formatCell(v, col)}
      </div>,
    );
  }
  return (
    <div className="row" data-index={index} data-ready={data ? "1" : ""} style={{ transform: `translateY(${start - HEADER}px)`, paddingLeft: x0 * COL_WIDTH }}>
      {cells}
    </div>
  );
}
// With memo, a row re-renders only when its props change. `data` is a fresh
// array on every Grid render, so the comparison looks at what it stands for.
const MemoRow = memo(RowImpl, (a, b) => a.index === b.index && a.start === b.start && a.x0 === b.x0 && a.x1 === b.x1 && a.version === b.version && !a.data === !b.data);
const Row = config.memo ? MemoRow : RowImpl;

function Grid({ scroller, source, onCommit }: { scroller: HTMLElement; source: Source; onCommit: (first: number, last: number) => void }) {
  const t0 = performance.now();
  c.renders++;
  allocateGarbage();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const force = useRef(rerender);
  force.current = rerender;
  (Grid as any).rerender = rerender;
  const rowV = useVirtualizer({ count: config.rows, getScrollElement: () => scroller, estimateSize: () => ROW_HEIGHT, scrollMargin: HEADER, overscan: config.overscan });
  const colV = useVirtualizer({ count: config.cols, getScrollElement: () => scroller, estimateSize: () => COL_WIDTH, horizontal: true, overscan: 1 });
  const rows = rowV.getVirtualItems();
  const cols = colV.getVirtualItems();
  const first = rows[0]?.index ?? 0;
  const last = rows[rows.length - 1]?.index ?? -1;
  const x0 = cols[0]?.index ?? 0;
  const x1 = cols[cols.length - 1]?.index ?? -1;
  let data: Cell[][] | undefined;
  if (rows.length && cols.length) {
    source.want(first, last + 1, x0, x1 + 1);
    data = source.peek(first, last + 1, x0, x1 + 1);
    if (!data) void source.get(first, last + 1, x0, x1 + 1).then(() => force.current());
  }
  const before = c.rowRenders;
  useLayoutEffect(() => {
    // After React has committed this render's DOM changes.
    c.commits++;
    measure("app: draw", { start: t0, detail: { lib: "react", first, last, x0, x1, rowRenders: c.rowRenders - before, filled: !!data } });
    onCommit(first, last);
  });
  const header = [];
  for (let col = x0; col <= x1; col++) header.push(<div key={col}>{columnName(col)}</div>);
  return (
    <>
      <div className="head" style={{ width: config.cols * COL_WIDTH, paddingLeft: x0 * COL_WIDTH }}>{header}</div>
      <div className="sizer" style={{ width: config.cols * COL_WIDTH, height: rowV.getTotalSize() }}>
        {rows.map((item) => (
          <Row key={item.index} index={item.index} start={item.start} x0={x0} x1={x1} data={data?.[item.index - first]} version={rowVersion.get(item.index) ?? 0} />
        ))}
      </div>
    </>
  );
}

export function mountReact(host: HTMLElement, source: Source): Panel {
  const { scroller, readout } = panelShell(host, "react", `@tanstack/react-virtual 3.14.26 · React 19${config.memo ? " · memo rows" : ""}`, document.createElement("div"));
  let complete = -1;
  const bodyHeight = config.height - HEADER;
  const row = (index: number) => scroller.querySelector<HTMLElement>(`.row[data-index="${index}"]`);
  // Where the scroller is, kept by a passive listener: reading scrollTop in
  // onCommit, right after React wrote the DOM, would force a layout.
  let top = 0;
  scroller.addEventListener("scroll", () => void (top = scroller.scrollTop), { passive: true, capture: true });
  const onCommit = () => {
    const first = Math.floor(top / ROW_HEIGHT);
    const last = Math.min(config.rows - 1, Math.floor((top + bodyHeight - 1) / ROW_HEIGHT));
    let ok = true;
    for (let r = first; r <= last && ok; r++) ok = row(r)?.dataset.ready === "1";
    if (ok && first !== complete) {
      complete = first;
      mark("app: content complete", { detail: { lib: "react", first, scrollTop: top } });
    }
    if (!config.bare) readout(`rows in DOM ${scroller.querySelectorAll(".row").length} · renders ${c.renders} · row renders ${c.rowRenders}`);
  };
  createRoot(scroller).render(<Grid scroller={scroller} source={source} onCommit={onCommit} />);
  return {
    id: "react",
    scroller,
    firstShown: () => {
      const first = Math.floor(top / ROW_HEIGHT);
      return row(first)?.dataset.ready === "1" ? first : -1;
    },
    rowsInDom: () => scroller.querySelectorAll(".row").length,
    cellsInDom: () => scroller.querySelectorAll(".row > div").length,
    cellText: (r, col) => {
      const el = row(r);
      if (!el) return null;
      const x0 = Math.round(parseFloat(el.style.paddingLeft || "0") / COL_WIDTH);
      return el.children[col - x0]?.textContent ?? null;
    },
    // A pushed value: bump the rows it touches and render again.
    update(cells) {
      for (const [r] of cells) rowVersion.set(r, (rowVersion.get(r) ?? 0) + 1);
      (Grid as any).rerender?.();
    },
    counters: () => ({ ...c }),
  };
}
