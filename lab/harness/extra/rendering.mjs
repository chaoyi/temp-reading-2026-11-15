// Module 5 (rendering.html): controls that isolate one rendering mechanism
// each, where the shared r- scenarios leave a claim without a trace.

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const scroll = [["gesture", { distance: 2400, speed: 2400, source: "mouse" }], ["wait", 500]];
// One cell changes per message, 60 messages a second, in a table whose 15 columns and about 32 rows are all on screen.
// Five runs each (the first trace is kept): a layout of a few hundred microseconds needs its spread shown.
const tick = (q) => ({ query: { cols: 15, hz: 60, n: 1, span: 30, apply: "msg", ...big, ...q }, actions: [["wait", 2000]], zero: "start", runs: 5, ...L });

export const scenarios = [
  {
    id: "r-fixed-regular",
    // colw=fixed sets table-layout: fixed on a <table> whose width is auto. Chrome then still uses auto
    // layout (ComputedStyle::IsFixedTableLayout), so this is the baseline again: an A/A control.
    asks: "regular-table with table-layout: fixed requested on a table of auto width: does anything change?",
    query: { lib: "regular", cols: 100, colw: "fixed", ...big },
    actions: scroll,
    ...L,
  },
  {
    id: "r-thrash-cls-regular",
    asks: "A class written and offsetWidth read, cell by cell: now every read finds something dirty. How many layouts?",
    query: { lib: "regular", cols: 100, cls: 1, thrash: 1, ...big },
    actions: scroll,
    ...L,
  },
  {
    id: "r-contain-positional",
    asks: "Rows that already exist, with contain: strict, and every cell's text rewritten: the row is a layout boundary now. Does it save anything?",
    query: { lib: "tanstack", pool: "positional", cols: 100, contain: 1, ...big },
    actions: scroll,
    ...L,
  },
  { id: "r-tick-regular", asks: "One cell of a 15 × 32 <table> changes, 60 times a second: what does layout redo?", ...tick({ lib: "regular" }) },
  { id: "r-tick-fixed-regular", asks: "The same single-cell updates with table-layout: fixed requested (auto width, so still auto layout): an A/A control.", ...tick({ lib: "regular", colw: "fixed" }) },
  { id: "r-tick-tanstack", asks: "The same single-cell updates into absolutely positioned flex rows.", ...tick({ lib: "tanstack" }) },
  { id: "r-tick-contain-tanstack", asks: "… and with contain: strict on each row: where does layout start now?", ...tick({ lib: "tanstack", contain: 1 }) },
];
