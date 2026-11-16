// What a cell's text costs. Each panel calls formatCell where its idiomatic
// render path touches a cell, so a trace's JavaScript samples show formatCell
// under whichever code asked for it, and `formatted` counts the calls.
//
//   fmt=plain    toFixed / String: about as cheap as text gets
//   fmt=intl     one shared Intl.NumberFormat: the recommended way
//   fmt=locale   Number.prototype.toLocaleString with options, per cell
//   fmt=newintl  a new Intl.NumberFormat per cell: the classic mistake
//   formatUs=N   N µs of busy work per cell on top, a stand-in for anything else

import { config } from "./config";
import { columnKind } from "./rows.js";

export let formatted = 0;
const OPTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;
const shared = new Intl.NumberFormat("en-US", OPTS);

export function formatCell(v: number | string, col: number): string {
  formatted++;
  if (config.formatUs > 0) {
    const end = performance.now() + config.formatUs / 1000;
    while (performance.now() < end) {
      // the work this cell's formatting would do
    }
  }
  if (typeof v === "string") return v;
  if (columnKind(col) !== "price") return String(v);
  switch (config.fmt) {
    case "intl":
      return shared.format(v);
    case "locale":
      return v.toLocaleString("en-US", OPTS);
    case "newintl":
      return new Intl.NumberFormat("en-US", OPTS).format(v);
    default:
      return v.toFixed(2);
  }
}

/** Conditional classes (cls=1): negative prices and large quantities. */
export function cellClass(v: number | string, col: number): string {
  if (typeof v !== "number") return "";
  const kind = columnKind(col);
  if (kind === "price") return v < 0 ? "neg" : "";
  if (kind === "qty") return v > 900 ? "big" : "";
  return "";
}

/** alloc=N: N KB of short-lived objects, as a draw that builds row objects would make. */
export function allocateGarbage(): number {
  if (!config.allocKb) return 0;
  let keep = 0;
  // ~64 bytes per small object with two number fields and a short string.
  for (let i = 0, n = config.allocKb * 16; i < n; i++) {
    const o = { a: i, b: i * 0.5, s: "r" + i };
    keep += o.s.length;
  }
  return keep;
}
