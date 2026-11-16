// What every panel shares: a titled box with a scroller and a readout line,
// and the interface the page and the harness use to inspect a table.

import type { Update } from "./ticks";

export interface Panel {
  id: string;
  /** The element that scrolls (and owns the scrollbars). */
  scroller: HTMLElement;
  /** The row shown at the top of the body, if its data is on screen; -1 otherwise. */
  firstShown(): number;
  rowsInDom(): number;
  cellsInDom(): number;
  cellText(row: number, col: number): string | null;
  /** Pushed values arrived for these cells (the overlay already holds them). */
  update(cells: Update[]): void;
  counters(): Record<string, number>;
}

export function panelShell<E extends HTMLElement>(host: HTMLElement, id: string, title: string, scroller: E) {
  const box = host.appendChild(document.createElement("section"));
  box.className = "panel";
  box.id = id;
  box.appendChild(document.createElement("h2")).textContent = title;
  scroller.classList.add("scroller");
  scroller.tabIndex = 0; // focusable, so Page Down goes to it
  box.appendChild(scroller);
  const line = box.appendChild(document.createElement("p"));
  line.className = "readout";
  let text = "";
  let scheduled = false;
  // The readout is written at most once per frame, after the table's own work.
  const readout = (t: string) => {
    text = t;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      line.textContent = text;
    });
  };
  return { scroller, readout };
}
