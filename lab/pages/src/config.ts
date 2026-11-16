// Every knob of the lab page comes from the URL, so a trace's scenario is one
// query string and a human can reproduce it by opening the same address.

// ?case=N (the clinic's unlabelled traces): the knobs come from sessionStorage,
// where the harness put them, so the trace's URLs do not give the answer away.
const hidden = new URLSearchParams(location.search).has("case") ? sessionStorage.getItem("lab-case") : null;
const q = new URLSearchParams(hidden ?? location.search);
const num = (k: string, d: number) => (q.has(k) && q.get(k) !== "" ? Number(q.get(k)) : d);
const str = <T extends string>(k: string, d: T, allowed: readonly T[]): T =>
  allowed.includes(q.get(k) as T) ? (q.get(k) as T) : d;

export const config = {
  /** Which table implementation to mount. */
  lib: str("lib", "tanstack", ["tanstack", "regular", "react"] as const),
  rows: num("rows", 100_000),
  cols: num("cols", 6),
  /** Scroller size in CSS pixels (the default is the first walkthrough's). */
  width: num("w", 640),
  height: num("h", 312),

  // ── where rows come from ──
  source: str("source", "local", ["local", "ws"] as const),
  serverMs: num("serverMs", 0),
  jitterMs: num("jitterMs", 0),
  /** Requests the backend serves at once; 0 = unlimited. 1 makes it a queue. */
  conc: num("conc", 0),
  padBytes: num("padBytes", 0),
  /** How our source asks: every missing range at once, or one request in flight (the newest wins). */
  policy: str("policy", "every", ["every", "inflight", "cancel"] as const),
  /** Route WebSockets through the netem proxy (bad network). */
  net: q.get("net") === "1",

  // ── what a cell costs ──
  fmt: str("fmt", "plain", ["plain", "intl", "locale", "newintl"] as const),
  formatUs: num("formatUs", 0),
  cls: q.get("cls") === "1",
  thrash: q.get("thrash") === "1",
  paint: str("paint", "plain", ["plain", "heavy"] as const),
  /** Kilobytes of short-lived objects allocated per draw (garbage-collector pressure). */
  allocKb: num("alloc", 0),

  // ── how the table is built ──
  overscan: num("overscan", 1),
  /** TanStack panel: keep a row element per row index, or reuse elements by screen position. */
  pool: str("pool", "keyed", ["keyed", "positional"] as const),
  /** React panel: wrap rows in React.memo. */
  memo: q.get("memo") === "1",
  /** regular-table: let it measure column widths (auto) or fix them in CSS. */
  colw: str("colw", "auto", ["auto", "fixed"] as const),
  /** CSS containment on rows/cells: none, or `contain: strict`-style hints. */
  contain: q.get("contain") === "1",
  /** A non-passive wheel listener on the scroller (the classic scroll-jank mistake). */
  wheelListener: str("wheel", "none", ["none", "passive", "blocking"] as const),

  // ── live updates pushed by the server ──
  tickHz: num("hz", 0),
  tickN: num("n", 1),
  tickSpan: num("span", 13),
  conflateMs: num("conflate", 0),
  wire: str("wire", "json", ["json", "bin"] as const),
  /** When updates reach the DOM: per message, once per animation frame, or parsed in a worker and pulled per frame. */
  apply: str("apply", "msg", ["msg", "raf", "worker"] as const),
  dropAbove: num("dropAbove", 0),

  /** marks=0: no performance.mark / measure calls (to measure the instrumentation itself). */
  marks: q.get("marks") !== "0",
  /** TanStack panel, colv=0: no column virtualizer; every column is rendered. */
  colv: q.get("colv") !== "0",
  /** regular-table, rtReset=1: call resetAutoSize() on every scroll event (as its file_browser example does). */
  rtReset: q.get("rtReset") === "1",
  bare: q.has("bare"),
};
export type Config = typeof config;
