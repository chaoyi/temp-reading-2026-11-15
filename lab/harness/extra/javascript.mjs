// Module 4 (javascript.html): the same large-viewport scroll as j-cells-L-*,
// with every performance.mark / performance.measure call switched off
// (marks=0). The sampled profile of the marked runs shows `measure` and `mark`
// among the top functions; these controls say what the panels cost without
// the course's own instrumentation, so the React-versus-vanilla difference
// can be stated without it.

const L = { viewport: { width: 1640, height: 860 } };
const big = { w: 1560, h: 792 };
const scroll = [["gesture", { distance: 2400, speed: 2400, source: "mouse" }], ["wait", 500]];
const asks = (what) => `${what}, with no performance.mark / measure calls: what does the panel itself cost per frame?`;

export const scenarios = [
  { id: "j-nomarks-keyed", asks: asks("The keyed TanStack panel"), query: { lib: "tanstack", cols: 100, marks: 0, ...big }, actions: scroll, ...L },
  { id: "j-nomarks-regular", asks: asks("regular-table"), query: { lib: "regular", cols: 100, marks: 0, ...big }, actions: scroll, ...L },
  { id: "j-nomarks-react", asks: asks("React rows"), query: { lib: "react", cols: 100, marks: 0, ...big }, actions: scroll, ...L },
  { id: "j-nomarks-memo", asks: asks("React rows wrapped in memo"), query: { lib: "react", cols: 100, memo: 1, marks: 0, ...big }, actions: scroll, ...L },
];
