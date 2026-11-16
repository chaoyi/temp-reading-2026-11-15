// The table every panel shows. Each cell is a pure function of (row, column),
// so the page, the backend and the checks agree without shipping a dataset.
// Plain JavaScript: the Node backend imports it too.
//
// Columns cycle through six kinds. Columns 0..5 are the ones the first
// walkthrough used; wider tables repeat the numeric kinds with other seeds.

export const ROW_HEIGHT = 24;
export const COL_WIDTH = 100;
const BASE = ["row", "symbol", "price", "qty", "region", "updated"];
const REGIONS = ["north", "south", "east", "west", "central"];

export function columnName(c) {
  return c < BASE.length ? BASE[c] : `${BASE[2 + (c % 2)]}${Math.floor(c / 2) - 2}`;
}

/** The kind of a column: how its raw value is produced and formatted. */
export function columnKind(c) {
  if (c < BASE.length) return BASE[c];
  return c % 2 === 0 ? "price" : "qty";
}

/** The raw value of one cell: a number for price/qty/row, a string otherwise. */
export function value(row, col) {
  switch (columnKind(col)) {
    case "row":
      return row;
    case "symbol":
      return "SYM" + String((row * 7919) % 5000).padStart(4, "0");
    case "price":
      return (((row * 37 + col * 7907) % 200_000) - 100_000) / 100; // -1000.00 .. 999.99
    case "qty":
      return (row * 13 + col * 101) % 1000;
    case "region":
      return REGIONS[(row * 31) % REGIONS.length];
    default: {
      const s = (row * 17) % 86_400;
      const two = (n) => String(n).padStart(2, "0");
      return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    }
  }
}

/** Rows y0 (inclusive) to y1 (exclusive) × columns x0..x1, row-major raw values. */
export function window_(y0, y1, x0, x1, rows) {
  const out = [];
  for (let r = y0; r < Math.min(y1, rows); r++) {
    const row = new Array(x1 - x0);
    for (let c = x0; c < x1; c++) row[c - x0] = value(r, c);
    out.push(row);
  }
  return out;
}

/** A sort key for the "sort" experiments: a scrambled permutation value per row. */
export function sortKey(row) {
  return (Math.imul(row + 1, 2654435761) >>> 0) / 4294967296;
}
