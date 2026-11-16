# Library anatomy: regular-table 0.9.2 and TanStack Virtual 3.19.11

Mechanism-level notes for the table-performance tracing curriculum. Written
2026-11-16 from source reading only; nothing was run. This goes below what
`notes/virtualization.html`, `notes/scrolling-survey.md` and
`samples/scroll-trace/WORKLOADS.md` already establish and does not repeat them.

**Tags.** **[src]** read in source at the pinned revision, with `path:line` and
the decisive line quoted; **[doc]** upstream prose (README, CHANGELOG, doc
comments that make claims); **[inf]** my inference, with what it is inferred
from. Nothing here is a measured performance fact. Where I write "forced
layout" it is always [inf]: the source shows a layout-dependent read after DOM
writes; whether Chrome actually recalculates depends on dirty state, which a
trace must show.

**Paths.** `rt:` = regular-table at `v0.9.2`
(`52e86bf8b74fc5948bb0047afbc8bb9207dd933c`, `~/src/repos/regular-table`).
`tv:` = TanStack Virtual at `@tanstack/virtual-core@3.19.11`
(`11b48e4ab8b08d483c8fe29a31ef11261ffbda04`,
`<checkout>/tanstack-virtual`; react-virtual 3.14.26 in
the same tree). `core:` abbreviates `tv:packages/virtual-core/src/index.ts`;
`react:` abbreviates `tv:packages/react-virtual/src/index.tsx`.

## 0. Finding the identifiers in a trace

- **regular-table's published bundle mangles every `_`-prefixed name.**
  `rt:build.mjs:29-33`: `minify: !process.env.PSP_DEBUG`,
  `minifyIdentifiers: true`, `mangleProps: /^[_#]/`. [src] In the installed
  0.9.2 `dist/esm/regular-table.js` the strings `_on_scroll`, `_render_pass`,
  `_draw_td`, `internal_draw`, `throttle_tag`, `flush_tag`, `_clean_rows`,
  `_get_cell` occur 0 times; `predraw`, `draw_sync`, `autosize_cells`,
  `updateColumnWidthStyles`, `flush_colspans`, `reset_header_cache`,
  `register_listeners` survive (counted in
  `/workspace/code/tablelab/app/node_modules/regular-table/dist/esm/regular-table.js`;
  a `.js.map` ships beside it). [src] The scroll-trace lab already serves the
  TypeScript source instead (`samples/scroll-trace/vite-plugin.mjs:3-4, 34-35`),
  so the names below appear there as written; a trace of any page using the
  npm `dist` build needs the source map. [src]
- **virtual-core's `dist/esm/index.js` is not minified**; `calculateRangeImpl`,
  `findNearestBinarySearchFlat`, `defaultRangeExtractor`, `resizeItem`,
  `reconcileScroll`, `scrollWithAdjustments`, `classifyScrollEvent`,
  `createLazyMeasurementsView` all occur (counted in
  `/workspace/code/tablelab/samples/node_modules/@tanstack/virtual-core/dist/esm/`). [src]
- **Five hot methods are `memo(...)` wrappers**: `maybeNotify`,
  `getMeasurements`, `calculateRange`, `getVirtualIndexes`, `getVirtualItems`
  (`core:1017, 1648, 1870, 1908, 2155`), plus `getMeasurementOptions` (`core:1597`).
  Each is the closure `function memoizedFunction()` (`tv:packages/virtual-core/src/utils.ts:20`),
  and its body is an anonymous arrow passed to `memo`. [src] So a JS sample
  shows `memoizedFunction` for all six, told apart only by caller and by the
  line of the anonymous callee. [inf, from how the functions are declared]
  Named frames to search for instead: `calculateRangeImpl`,
  `findNearestBinarySearchFlat`, `defaultRangeExtractor`, the Proxy trap `get`
  in `lazy-measurements.js`, `measureElement`, `scrollWithAdjustments`,
  `classifyScrollEvent`. The scroll listener itself is the anonymous arrow
  returned by `createHandler` (`core:217-221`). [src]

---

# regular-table 0.9.2

Class chain: `RegularTableElement` (`rt:src/ts/regular-table.ts:48`) →
`RegularViewEventModel` (`rt:src/ts/events.ts:33`) →
`RegularVirtualTableViewModel` (`rt:src/ts/scroll_panel.ts:81`) → `HTMLElement`.
It owns one `RegularTableViewModel` (`rt:src/ts/table.ts:357`) with a
`RegularHeaderViewModel` (`thead.ts:35`) and `RegularBodyViewModel`
(`tbody.ts:27`), both `ViewModel` (`view_model.ts:30`). [src]

## 1. Draw scheduling

### 1.1 There are two draw pipelines, not one

- **Async pipeline**: `draw()` → `internal_draw` (`scroll_panel.ts:980`) →
  `RegularTableViewModel.draw` (`table.ts:713`). It writes the DOM in whatever
  microtask follows each resolved `await`; it never waits for an animation
  frame. [src: no `requestAnimationFrame` in `internal_draw` or `table.ts`;
  the only occurrences are `events.ts:87, 383`, `regular-table.ts:313`, `utils.ts:53`]
- **Plan-then-commit pipeline**: `predraw()` (`scroll_panel.ts:160`) does all
  awaits (dimensions, data) without touching the table, and returns a
  synchronous closure; `_on_scroll` awaits one `requestAnimationFrame` and
  calls it; the closure runs `draw_sync` (`table.ts:769`). [src]
- Both drive the **same generator**, `_render_pass` (`table.ts:813`):
  "The single render pass shared by `draw()` (which awaits each yielded effect)
  and `draw_sync()` (which runs it to completion synchronously against a
  pre-fetched slab)" (`table.ts:803-805`). [src]
- The scroll path uses the second pipeline only since #284 (section 6);
  `predraw` itself arrived in #278, v0.8.6 (`rt:CHANGELOG.md:37`). [src]

### 1.2 Every entry point that can start a draw

| Entry point | Call | Pipeline |
|---|---|---|
| `scroll` event | `events.ts:50` `addEventListener("scroll", this._on_scroll.bind(this), { passive: true })` → `predraw(width, height, { invalid_viewport: false, cache: true, throttle: false, … })` (`events.ts:77-84`) | plan-then-commit; falls back to async "inline" (1.4) |
| public `draw(options)` | `scroll_panel.ts:113-121` | async, through `throttle_tag` unless `options.throttle === false` |
| public `predraw(w, h, options)` | `scroll_panel.ts:160` | caller decides when to commit |
| corrective redraw after a commit that ran out of data | `scroll_panel.ts:352-354` `if (!complete) { this.draw({ invalid_viewport: true }); }` | async |
| column width changed after layout (autosize `ResizeObserver`) | `table.ts:464` `this._on_autosize_change?.()` → `_autosize_fill_check` → `scroll_panel.ts:536` `this.draw({ invalid_viewport: true })` | async |
| double-click on a `.rt-column-resize` handle | `events.ts:266` `await this.draw({ cache: true })` | async |
| column drag, `mousemove` | `events.ts:337-349` `throttle_tag(this, …_on_resize_column_move…)`, which awaits a rAF (`events.ts:383`) then, when shrinking, `this.draw({ preserve_width: true, throttle: false, cache: true })` (`events.ts:391-395`) | async, inside the tag |
| column drag, `mouseup` | `events.ts:358` `this.draw({ cache: true })` | async |
| `scrollToCell(x, y)` | writes `this.scrollTop`/`scrollLeft` (`regular-table.ts:302, 312`), then `await new Promise(requestAnimationFrame); await this.flush();` (313-314) | via the scroll event |
| Safari only: `mousewheel` | `events.ts:128` `if (!window.hasOwnProperty("safari")) { return; }`, else writes `scrollTop`/`scrollLeft` and calls `this._on_scroll(event)` (147-157) | as scroll |

[src] for every row.

**Not** entry points [src, by reading each]: `resetAutoSize()` only clears
caches (`regular-table.ts:86-102`); `setDataListener()` only stores the
listener and sets `this._invalid_schema = true` (`regular-table.ts:368`);
`connectedCallback()` builds the shadow DOM and table model
(`regular-table.ts:58-66`); `clear()` rebuilds the table model (125-127).
**There is no resize handling for the host element**: the only
`ResizeObserver` in `src/ts` is the per-header-cell autosize observer
(`table.ts:397`), and there is no `window` `resize` listener. A container
resize is picked up only by the next `draw()` or scroll, each of which re-reads
`clientWidth`/`clientHeight` (`events.ts:70-72`, `scroll_panel.ts:997-999`). [src]
The touch handlers are dead code: `const IOS_DISABLE_OVERSCROLL = false`
(`events.ts:25`, used at 110). [src]

### 1.3 The lock: `throttle_tag`, and the two scroll flags

There is no `_draw_flush`. The real names are `throttle_tag`, `flush_tag`
(module functions over `const TAGS: Map<any, PromiseWithResolvers<undefined>>`,
`utils.ts:48`), and the fields `_scroll_pending` (`scroll_panel.ts:98`) and
`_scroll_dirty` (`events.ts:39`). [src] `_invalidated` and `_is_styling` are
declared (`scroll_panel.ts:94-95`) and never read. [src]

```ts
// utils.ts:57-77
export async function throttle_tag<T>(tag: any, f: () => Promise<T>) {
    if (TAGS.has(tag)) {
        await TAGS.get(tag)?.promise;
        if (TAGS.has(tag)) {
            await TAGS.get(tag)?.promise;
            return;
        }
    }
    TAGS.set(tag, Promise.withResolvers());
    try { return await f(); }
    finally { const l = TAGS.get(tag); TAGS.delete(tag); l?.resolve(undefined); }
}
```

- The tag is the element (`throttle_tag(this, …)`), shared by `draw()`
  (`scroll_panel.ts:117`), the scroll loop (`events.ts:74`) and the column-drag
  move (`events.ts:338`). One tagged operation runs at a time per element. [src]
- With no operation in flight, `f()` is called synchronously, so the start of
  the work runs inside the caller's task. [src]
- A call that arrives while one is in flight waits for it. When it finishes,
  the first waiter finds the tag free and runs its own `f`; every other waiter
  from the same wait finds the tag taken again, waits for that one too, then
  **returns without running its `f`** (the inner `return;`). So of N calls
  queued behind one operation, exactly one runs, and it is the **first** queued
  one with its own options, not the last. [inf, from the code above plus
  promise continuations resuming in registration order] Position is still the
  latest, because `internal_draw` reads `this.scrollTop` when it runs
  (`scroll_panel.ts:1014`). [src]
- `throttle: false` bypasses the tag: `return await internal_draw.call(this, options)`
  (`scroll_panel.ts:114-115`). The scroll loop passes it because it already
  holds the tag. [src; "because" is inf]

### 1.4 Scroll event → committed DOM, await by await

All [src] unless marked. Line numbers are `events.ts` for `_on_scroll`,
`scroll_panel.ts` for `predraw`.

1. **Synchronously in the scroll event.** `event.stopPropagation()`; read
   `this.scrollLeft`, `this.scrollTop` into `_scroll_left`/`_scroll_top`
   (62-63). `if (this._scroll_pending) { this._scroll_dirty = true; return; }`
   (64-67): an event during a draw costs two property reads and two writes.
2. Otherwise `this._scroll_pending = true` and three layout reads:
   `this._table_clip.clientWidth`, `this._table_clip.clientHeight`,
   `this.clientHeight` (70-72). These are captured **once** and reused by every
   iteration of the loop in step 9.
3. `await throttle_tag(this, async () => { do { … } while (this._scroll_dirty); })`
   (74-91). If a `draw()` is in flight the handler waits here.
4. Loop body: `this._scroll_dirty = false`, then
   `const commit = await this.predraw(width, height, { invalid_viewport: false, cache: true, throttle: false, container_height, scroll_left: this._scroll_left, scroll_top: this._scroll_top })` (76-84).
5. **Await 1** in `predraw`: `await this._update_dim_state(cache)` (194) →
   `table_model._getDimState` (`table.ts:700-706`). With `cache: true` and a
   previous response it returns `this._lastDataResponse` without calling the
   listener; this await is then only microtask hops. With no previous
   response it calls `view_cache.view(0, 0, 0, 0)`.
6. Pure planning, no DOM reads: `_resolve_container_size` from the passed
   numbers (201-205), `_virtual_panel_height` (208-210), clamp `scroll_top`
   (212-219), then `_calculate_viewport` (229), `_plan_column_extent` (236),
   `_validate_viewport` (251-252). Two early exits:
   - `if (!this._column_sizes.row_height) { return await inline(); }` (195-197)
     and `if (end_col === undefined) { return await inline(); }` (241-243):
     the row height or a needed column width is not cached, so it runs the
     **async pipeline right now** (`inline` = `await this.draw({ …, throttle })`,
     178-187) and returns a no-op commit with `inline: true`. Step 8's rAF is
     then skipped.
   - `if (!should_render) { break; }` (272-274): the integer viewport is
     unchanged, so there is no data call at all.
7. **Await 2**: `view_response = await this._view_cache.view(Math.floor(viewport.start_col), Math.floor(viewport.start_row), Math.ceil(viewport.end_col), Math.ceil(viewport.end_row))`
   (276-281): the data listener. Possibly a second call (section 2).
8. **Await 3**, back in `_on_scroll`: `if (!commit.inline) { await new Promise(requestAnimationFrame); commit(); }` (86-89).
9. `commit()` is synchronous (297-357): `_commit_viewport` (299);
   `_update_virtual_panels` (300-305), which writes the panel height;
   then either only `_update_sub_cell_offset(viewport)` when nothing is to be
   rendered (307-310), or `table_model.draw_sync(…)` (329) with style listeners
   called and not awaited (319-326), then `_post_render` (340-346).
   `while (this._scroll_dirty)` (90) repeats from step 4 with the newest
   stored position.
10. `finally { this._scroll_pending = false; }` (92-94), then
    `this.dispatchEvent(new CustomEvent("regular-table-scroll"))` (96).

Timing notes [inf]:

- Steps 1-7 up to the listener call run in the scroll event's task (step 5 is
  microtasks). So the data listener is *called* inside the scroll event
  dispatch, before that frame's animation-frame callbacks, when no draw is in
  flight. [inf, from the synchronous call chain and no intervening macrotask]
- If the listener's promise resolves within microtasks, the rAF of step 8 is
  requested during scroll-event dispatch, which the HTML rendering steps place
  before "run the animation frame callbacks"; the commit can then land in the
  **same** frame as the scroll event. With a listener that waits on I/O the
  commit is at least one frame later. [inf from spec ordering; measure]
- Each loop iteration ends with one rAF wait, so the scroll path commits at
  most once per animation frame. [inf, from step 8]
- The inline fallback writes the DOM outside any rAF. [inf, from 1.1]

### 1.5 A position that arrives while a draw is in flight; cancellation

- It overwrites `_scroll_left`/`_scroll_top` and sets `_scroll_dirty`
  (`events.ts:62-66`). Only the latest survives; intermediate positions are
  never drawn. [src]
- **There is no cancellation or invalidation.** Nothing between
  `await this._view_cache.view(…)` and `commit()` compares the planned
  viewport with the current scroll position; the iteration in flight still
  waits for its data, waits for its frame and commits the superseded viewport
  in full; only then does the loop plan the newest position. [src:
  `events.ts:75-90` has no such check; `predraw` reads `scroll_top` only from
  its options, `scroll_panel.ts:169-170`] So a drag over slow data alternates
  "commit stale position" / "plan newest". [inf]
- The only "redo" is about **columns, not position**: the commit returns
  `false` when the pre-fetched slab did not fill the width, and schedules
  `this.draw({ invalid_viewport: true })` (`scroll_panel.ts:352-354`). The doc
  comment gives the causes: "the data set changed shape between plan and
  commit, or a style listener shrank columns below their measured widths"
  (`table.ts:765-766`). [src] [doc]
- The async pipeline does not re-check either: `internal_draw` reads
  `scrollTop` once (`scroll_panel.ts:1014`), calls `_commit_viewport` before
  awaiting data (1019), and renders whatever comes back. [src]
- Edge [inf, from 1.3]: if two or more `draw()` calls are queued behind an
  in-flight draw and a scroll arrives, the scroll's loop is one of the dropped
  waiters; a later scroll during the queued draw sets `_scroll_dirty` with
  nobody left to consume it, so that position is drawn only at the next scroll
  event or `draw()`.

### 1.6 What `flush()` waits for

```ts
// scroll_panel.ts:126-132          // utils.ts:50-55
async flush() {                     export async function flush_tag(tag) {
    do { await flush_tag(this); }       await new Promise(requestAnimationFrame);
    while (this._scroll_pending);       return await TAGS.get(tag)?.promise;
}                                   }
```

One animation frame, then the tagged operation in flight at that moment (if
any), repeated while a scroll-driven draw is pending. [src] It does not wait
for a `draw()` that is still queued behind the operation it awaited, unless
`_scroll_pending` keeps the loop going. [inf]

## 2. How many data-listener calls one draw makes

`ViewCache` is not a data cache: `{ view, row_headers_length, column_headers_length }`
(`types.ts:312-316`); `view` is the listener. The only cached response is
`_lastDataResponse` (`table.ts:363`), used for dimensions. There is no swap or
double buffer in the code: `cloneNode` does not occur in `src/ts`, although the
class comment still describes one (`scroll_panel.ts:73-77`). [src]

### 2.1 Async pipeline (`draw()`, and the scroll path's inline fallback)

1. **Dimension probe, unless `cache: true`.** `_update_dim_state`:
   `if (!cache) { this.table_model._resetDimState(); }` (`scroll_panel.ts:369-371`),
   then `_getDimState`: `if (!this._lastDataResponse) { return await view_cache.view(0, 0, 0, 0); }`
   (`table.ts:701-703`). A plain `table.draw()` therefore always starts with a
   `(0, 0, 0, 0)` call, read for `num_rows`, `num_columns`, `row_height`,
   `num_row_headers`, `num_column_headers` (`scroll_panel.ts:373-386`). [src]
2. **First window, with an estimated column extent.**
   `view_cache.view(floor(start_col), floor(start_row), ceil(end_col), ceil(end_row))`
   (`table.ts:723-728`). `end_col = start_col + vis_cols + 1` where
   `vis_cols = this.table_model.num_columns() || Math.min(num_columns, Math.ceil(this._container_size.width / 60))`
   (`scroll_panel.ts:804-810`): the number of cells in the last header row left
   by the previous draw (`view_model.ts:49-52`), or width ÷ 60 px. In this
   path `x1` is not clamped to `num_columns`. [src]
3. **Continuations until the width is filled.** `_render_pass` draws column by
   column: `while (dcidx < num_visible_columns)` (`table.ts:901`). When it
   reaches a column the response does not hold, `if (!view_response.data[dcidx])`
   (903), it yields `{ fetch }` (911-924) → `_fetchMissingColumns` →
   `await view(floor(new_viewport.start_col), floor(start_row), ceil(new_viewport.end_col), ceil(end_row))`
   (`table.ts:293-298`) and splices the new columns into `view_response`
   (316-326). The extension size comes from `_calculateViewportExtension`
   (`table.ts:179-210`): walk the known widths to the right until the remaining
   width is covered; if they do not cover it,
   `const estimate = Math.min(num_columns, viewport.start_col + 5)`, five more
   columns. [src]
4. The loop stops when `_isViewportFilled`
   (`view_state.viewport_width - view_state.sub_cell_offset > container_width`,
   `table.ts:1079-1082`) holds after re-measuring (1052-1054), when a
   continuation returns no columns (`if (new_col.data.length === 0)`, 311;
   then 935-954), or when `dcidx` reaches `num_columns - viewport.start_col`
   (898, 901). [src]

So calls per async draw = (1 unless `cache`) + 1 + k, with k ≥ 0 continuations
and no fixed upper bound other than the column count. [inf, from 1-4] k is 0
when the estimate covered the viewport; it is positive mainly on the first
draw and when scrolling right into columns narrower than estimated. [inf]

### 2.2 Plan-then-commit pipeline (the normal scroll path)

- **0 calls** when floor/ceil of the viewport is unchanged and the schema is
  valid: `should_render = invalid_schema_or_column || invalid_row || invalid_viewport`
  (`scroll_panel.ts:258-259`) with `invalid_viewport: false` from the scroll
  path, then `if (!should_render) { break; }` (272-274). `_validate_viewport`
  compares `Math.floor(start_row)`, `Math.ceil(end_row)`, `Math.floor(start_col)`,
  `Math.ceil(end_col)` with the last committed values (651-659). [src] Because
  `end_row` is `start_row` plus a fractional row count, `ceil(end_row)` can
  change while `floor(start_row)` does not, so a move inside one row can still
  fetch and render. [inf, from 651-659 and 867-877]
- **1 call** normally, with an **exact** column extent computed from cached
  widths: `_plan_column_extent` (`scroll_panel.ts:460-503`) sums
  `override[size_key] ?? indices[size_key]` until the container width is
  covered, and `replanned.end_col = Math.min(safe_num_columns, end_col + PREDRAW_COLUMN_PAD)`
  (245-248; `const PREDRAW_COLUMN_PAD = 1`, line 41). Rows are
  `floor(start_row)` to `ceil(end_row)`, no overscan. [src]
- **2 calls** at most: `for (let attempt = 0; attempt < 2; attempt++)` (225).
  After the first response, if the number of row-header columns differs from
  the plan (`if (actual_row_headers_length === planned_row_headers_length) { break; }`,
  288-290) it replans; the second fetch is skipped when "The already-fetched
  slab is a superset" (260-269). [src]
- **+1 dimension call** only if no response is cached (step 5 of 1.4). [src]
- **No continuation calls in the commit.** `draw_sync` resumes the generator
  with nothing (`step = render_pass.next()`, `table.ts:796`), so a `{ fetch }`
  yield returns `undefined` and the pass ends on its data-exhausted path
  (935-954), returning `_isViewportFilled(…)`; `false` triggers the corrective
  async `draw({ invalid_viewport: true })`, which costs a `(0,0,0,0)` probe
  plus a window. [src] The Playwright suite asserts the pattern: "performs all
  DataListener calls before resolving" (`rt:tests/predraw.spec.js:219`). [doc]
- **Unknown width → inline.** `_plan_column_extent` returns `undefined` when
  any candidate column "has never been measured" (454-458, 479-481, 494-496),
  and the scroll falls back to 2.1 with `cache: true` (no probe) and no rAF.
  Scrolling right into unvisited columns therefore takes the async pipeline;
  vertical scrolling over measured columns takes the commit pipeline. [src; the
  last sentence is inf]

## 3. Viewport math

### 3.1 Container and virtual panel

- Shadow DOM: `<div class="rt-virtual-panel"></div><div class="rt-scroll-table-clip"><slot></slot></div>`
  (`scroll_panel.ts:39`); the `<table>` is light DOM, slotted
  (`table.ts:473-474`: `element.innerHTML = '<table cellspacing="0"><thead></thead><tbody></tbody></table>'`). [src]
- The host is the scroller: `:host { position: absolute; … overflow: scroll; overflow-anchor: none; overscroll-behavior: none; }`
  (`rt:src/less/container.less:12-22`). The panel is
  `position: absolute; top: 0; left: 0; right: 0; pointer-events: none`
  (24-30). The clip is `position: sticky; contain: strict; overflow-anchor: none; width: 100%; height: 100%`
  (35-41); the slot is `position: absolute; overflow: hidden` (43-47). [src]
- Panel height: `Math.min(BROWSER_MAX_HEIGHT, nrows * row_height + header_height)`
  with `header_height = this._view_cache.column_headers_length * row_height`
  (`scroll_panel.ts:734-739`), written as
  `` `${virtual_panel_px_size.toPrecision(10)}px` `` on every draw and every
  commit (723-726, called from 423). It is computed, not read back: "avoids a
  forced layout in the draw path" (730-732). [src] [doc]
- Panel width (mode `both`/`horizontal`) is an estimate that changes as
  columns are measured: `this._container_size.width + virtual_width + 2`
  (707-710), `virtual_width` = sum of `this._column_sizes.indices[cidx] || 60`
  for every column up to the last scrollable one (948-957), a loop over
  `num_columns`. It is recomputed only when `invalid` is true: before an async
  draw when `invalid_viewport` (1002-1007), and after a render when the schema
  or the first column changed (`_post_render`, 448-450). A pure vertical step
  does not recompute it. [src]

### 3.2 scrollTop → rows, below and above the cap

`_calculate_row_range` (`scroll_panel.ts:851-879`) [src]:

```ts
const panel_height = Math.round(this._virtual_panel_height(nrows));
const total_scroll_height = Math.max(1, panel_height - containerHeight);
const percent_scroll = Math.max(Math.ceil(scroll_top), 0) / total_scroll_height;
const clip_panel_row_height = height / row_height - header_levels;
const scrollable_rows = Math.max(0, relative_nrows - clip_panel_row_height);
const start_row = scrollable_rows * percent_scroll;
const end_row = Math.max(0, Math.min(start_row + clip_panel_row_height, nrows));
```

- The mapping is **always proportional**; there is no separate code path above
  the cap. Below the cap `total_scroll_height ≈ scrollable_rows × row_height`,
  so one pixel is `1 / row_height` rows; above it the numerator keeps growing
  and the denominator is pinned at `BROWSER_MAX_HEIGHT - containerHeight`, so
  one pixel is `scrollable_rows / (10,000,000 - containerHeight)` rows. [inf,
  from the formula and `constants.ts:18`:
  `export const BROWSER_MAX_HEIGHT = isFirefox ? 5000000 : 10000000;`]
- `start_row` is fractional. The listener gets `Math.floor(start_row)` and
  `Math.ceil(end_row)`. [src]
- `height` is `_table_clip.clientHeight` and `containerHeight` is the host's
  `clientHeight` (`events.ts:71-72`, `scroll_panel.ts:998-999`). [src]
- Columns: `_calc_start_column` walks widths from column 0 until the
  cumulative width passes `scroll_left` (`scroll_panel.ts:881-900`,
  `offset_width += new_val !== undefined ? new_val : 60`), a loop of length
  `start_col` on every plan; the fractional part is `diff / width`. [src]

### 3.3 Sub-cell offsets and the sticky table

- `_update_sub_cell_offset` (`scroll_panel.ts:766-781`):
  `y_offset = row_height * (viewport.start_row % 1)`,
  `x_offset = (indices[x_offset_index] ?? this.table_model._estimated_column_width()) * (viewport.start_col % 1)`.
  `_set_sub_cell_offset` writes four custom properties on the `<table>`'s
  inline style: `--regular-table--clip-x`, `--regular-table--clip-y`,
  `--regular-table--transform-x`, `--regular-table--transform-y` (753-759;
  names at 34-37). [src]
- They do nothing unless optional CSS consumes them
  (`rt:src/less/sub-cell-scrolling.less:13-52`, imported by `material.less:13`):
  `tbody { transform: translate(0, var(--regular-table--transform-y, 0px)); }`;
  `tbody td, thead th:not(.rt-group-corner) { transform: translate(var(--regular-table--transform-x, 0px), 0); }`;
  `clip-path: polygon(…)` on the first row's cells and each row's first `td`.
  [src] Without that stylesheet scrolling is "in increments of a cell"
  (`rt:README.md:517-518`). [doc]
- The offsets are written only inside a draw or commit (`scroll_panel.ts:308,
  315, 440, 1035, 1055`), never directly in the scroll handler. [src] So
  between commits the sticky table neither moves nor changes; the user sees
  the previous frame's rows at the previous sub-row offset while the scrollbar
  thumb moves. [inf, from sticky positioning plus the write sites]
- They were moved from a constructed-stylesheet rule to the table's inline
  style in v0.9.2 because "WebKit does not reliably invalidate the slotted
  element's computed style" (`scroll_panel.ts:745-751`). [doc] Custom
  properties inherit, so one write on `<table>` invalidates style for every
  cell under it. [inf, from "from where they inherit into every cell", 743]
- Positioning of the sticky clip: `_setup_virtual_scroll`
  (`scroll_panel.ts:584-610`) sets `this._table_clip.style.top = "0px"` for
  `both`/`vertical` and `style.left = "0px"` for `both`/`horizontal`, and
  `style.contain = "none"` for anything except `both`. The theme adds
  `table { position: absolute; overflow: hidden; }` (`material.less:97-102`). [src]

### 3.4 `virtual_mode` (option of `setDataListener`, default `"both"`)

| Mode | Sticky offsets | Container size given to the math | Effect |
|---|---|---|---|
| `both` | `top: 0`, `left: 0`; `contain: strict` kept | real width and height | both axes windowed |
| `vertical` | `top: 0` only; `contain: none` | `width: Infinity` (`scroll_panel.ts:404-408`) | `_calculate_column_range` returns `{ start_col: 0, end_col: Infinity }` (797-801); every column is requested and drawn; `clientWidth` is not read; panel width = sum of measured widths (691-701); `_plan_column_extent` returns `viewport.end_col` (464-469), so no inline fallback for widths |
| `horizontal` | `left: 0` only; `contain: none` | `height: Infinity`, `containerHeight: Infinity` (400-411) | `total_scroll_height = Math.max(1, …) = 1`, `scrollable_rows = 0`, `end_row = nrows`: every row is requested and drawn [inf, substituting `Infinity` into 3.2] |
| `none` | neither; `contain: none` | all `Infinity` | everything is drawn; the table scrolls natively |

[src] except where marked. "will render the _entire_ `<table>` along the
non-virtual axis(es)" (`rt:README.md:243-245`). [doc] The thunks exist so a
masked axis "must not force layout" (`scroll_panel.ts:391-394`). [doc]

## 4. Column auto-sizing

### 4.1 The caches (`ColumnSizes`, `types.ts:491-496`)

`size_key` = row-header column index, or `row_headers_length + x` for data
column `x` (`table.ts:240`, `types.ts:84-85`). [src]

| Field | Meaning | Written by |
|---|---|---|
| `indices[size_key]` | last measured width (px ÷ CSS zoom); drives all viewport math | `autosize_cells` (`table.ts:534-535`), `_on_autosize_entries` (459), column-drag mouseup (`events.ts:356`) |
| `auto[size_key]` | measured width when no override exists; becomes the column's `min-width` | `table.ts:538-541`, 460 |
| `override[size_key]` | user-dragged width; becomes `min-width` and `max-width` | `events.ts:386`; `restoreColumnSizes` |
| `row_height` | one height for all rows | `_probe_row_height` (`scroll_panel.ts:560`), listener's `row_height` (375-376), `autosize_cells` (523-531) |

How widths reach the DOM: one `CSSStyleRule` per column in a sheet adopted on
the table's root, selector `` `.${this._scope_class} .rt-col-${size_key}{}` ``
(`table.ts:655`); `_setColumnRule` writes `rule.style.minWidth` (and
`maxWidth` for overrides), skipped when `_columnWidthCache` holds the same
value (666-669, 676-683). Leaf header cells always carry `rt-col-K`
(`thead.ts:125`); body cells carry it only when clipped by an override or
with `column_classes` (`tbody.ts:52-56`). [src] Auto width is a floor only
("auto is a grow-to-content floor (min only)", `table.ts:598-599`), so an
auto-sized column can grow with wider content but does not shrink until a
reset. [doc] [inf for "does not shrink"]

### 4.2 Layout reads, in the order a draw makes them

| # | Read | Where | When |
|---|---|---|---|
| a | `scrollLeft`, `scrollTop` | `events.ts:62-63` | every scroll event |
| b | `_table_clip.clientWidth`, `_table_clip.clientHeight`, `clientHeight` | `events.ts:70-72`; `scroll_panel.ts:997-999` | once per accepted scroll event; once per async draw (masked axes not read) |
| c | probe: `this.appendChild(this._probe_element[0]); … = this._probe_element[1].offsetHeight; this._probe_element[0].remove();` | `scroll_panel.ts:559-561` | only when `row_height` is unset: first draw, or after a reset |
| d | `this.scrollTop`, `this.scrollLeft` **after** the panel style writes | `scroll_panel.ts:1002-1016` ("Scroll positions are read after the virtual panel writes above, as the browser may clamp them when the panel shrinks") | every async draw |
| e | `this._column_sizes.indices[i] \|\| th.offsetWidth` | `table.ts:157` | per row-header column not yet measured |
| f | `row_height = row_height \|\| obj?.td.offsetHeight` | `tbody.ts:223` | per cell only while `view_state.row_height` is falsy |
| g | `col_width = cont_head?.th?.offsetWidth \|\| 0` (else the sum of the column's `td.offsetWidth`) | `table.ts:995-1001` | when the column just drawn has no cached width and no reusable estimate (below) |
| h | `cell.getBoundingClientRect()` for every entry of `last_cells`, all reads first | `table.ts:517-520` in `autosize_cells` | after style listeners, only `if (this._needs_autosize(last_cells))` |
| i | `entry.target.getBoundingClientRect().width / zoom` | `table.ts:446` in `_on_autosize_entries` | later, in the `ResizeObserver` callback, per changed header cell |

[src] for every row.

Read g in detail (`table.ts:991-1004`):

```ts
let col_width = this._column_sizes.indices[_virtual_x + Math.floor(x0)]
             || (warm ? unmeasured_col_width : 0);
if (!col_width) { col_width = cont_head?.th?.offsetWidth || 0; …; unmeasured_col_width = col_width; }
```

with `const warm = this._column_sizes.indices.some(Boolean)` (900) taken once
per pass, and `unmeasured_col_width = 0` again after each measuring step (1041). [src]

### 4.3 Layout passes per draw as a function of visible columns C

All [inf], counting the reads above that follow DOM writes; R = row-header columns.

- **Cold** (no width ever measured, so `warm === false`): read g runs for
  **every** data column, each just after that column's cells were written, so
  up to **C** read-after-write points, plus R for read e, plus one batched
  pass for read h, plus the probe c on the very first draw. This is the first
  draw and every draw after a full `resetAutoSize()`.
- **Warm, some visible columns unmeasured**: one read g per measuring step
  (the first unmeasured column; its width stands in for the rest), plus one
  batched read h. If the real widths then do not fill the viewport
  (`table.ts:1052-1054`) the loop draws more columns and repeats, so it is
  1 + 1 per fill attempt, not per column.
- **Warm, all visible columns measured** (steady vertical scrolling): no
  layout read inside the render pass at all; `_needs_autosize` returns false
  because every `size_key` has `indices[size_key]` (`table.ts:477-495`). The
  scroll path's reads are a and b only, both before any write.
- The async pipeline adds read d after two style writes on the panel.
- A style listener's own reads are on top of these; it runs before read h
  (`yield "style"` at `table.ts:1021`, then `autosize_cells` at 1032-1037), so
  the batched measurement sees the listener's writes.

`last_cells` holds one cell per drawn column, the header cell if the column
has one, else the last body cell drawn (`table.ts:976-983`; `tds[0]` is
overwritten per row, `tbody.ts:215`). [src] Measuring is skipped entirely for
`preserve_width` draws (976, 1026-1028). [src]

After #284 the growth of an already-measured column is noticed by a
`ResizeObserver` on each leaf header cell (`thead.ts:126`
`this._observe_autosize?.(th)`; observer at `table.ts:397-399`). While an
async draw is running it re-queues its entries instead of reading
(`if (this._draw_in_flight) { … unobserve … observe … return; }`, 425-432);
`_draw_in_flight` is set only by the async `draw` (740, 752), not by
`draw_sync`. On a change it updates `indices`/`auto`, the column rule, and
calls `_autosize_fill_check`, which starts a full `draw({ invalid_viewport: true })`
if the measured widths no longer fill the container (`scroll_panel.ts:505-538`). [src]
Columns without a header cell are not observed. [inf, from `_observe_autosize`
being called only in `_draw_th`]

### 4.4 `resetAutoSize(options?)`

`regular-table.ts:86-102`: with no options it sets
`this._column_sizes.auto = []`, `.override = {}`, `.indices = []`,
`.row_height = undefined`; each of the four is selectable through
`{ auto, override, indices, row_height }`. [src] It does not draw, and it does
not touch the generated CSS rules, `_columnWidthCache` or
`_measured_overrides`; visible columns' rules are cleared lazily by the next
draw's `updateColumnWidthStyles` → `_clearColumnRule` (`table.ts:601-611,
686-698`). [src]

Consequences for the next draw [inf, from 1.4 step 6 and 4.3]: the row-height
probe runs again; `warm` is false, so one `offsetWidth` read per column; the
batched `getBoundingClientRect` pass runs; and the next **scroll** cannot use
the commit pipeline (no `row_height`, no widths), so it draws inline, outside
rAF. The test suite states the last point: "falls back to drawing inline after
resetAutoSize()" (`rt:tests/predraw.spec.js:46`). [doc] `examples/file_browser`
calls `regularTable.resetAutoSize()` in a `scroll` listener
(`rt:examples/file_browser/file_browser.js:198-200`), which forces this path
on every scroll event there. [src] [inf]

## 5. DOM management

### 5.1 Rows and cells: a positional pool, created on demand, trimmed from the end

- State: `cells: (HTMLTableCellElement | undefined)[][]` and
  `rows: HTMLTableRowElement[]` per section (`view_model.ts:34-35`). [src]
- `_get_cell(tag, ridx, cidx)` (`view_model.ts:156-182`) returns the existing
  element at that position, or creates it (`document.createElement(tag)`,
  `tr.appendChild(td)` or `tr.insertBefore`), creating the `<tr>` through
  `_get_row` (138-154: `this.table.appendChild(tr)`). A cell whose tag differs
  (`TD` vs `TH`) is replaced (`tr.replaceChild`, 174-179). Rows and cells are
  never moved or reordered; row *i* of the `<tbody>` always shows the *i*-th
  visible row. [src]
- Removal is only truncation: `_clean_rows(ridx)` removes `<tr>`s from `ridx`
  on (201-216); `_clean_columns(cidx)` truncates **every** row to `cidx` cells
  (184-199: `row_container.length = …`, then
  `this.cells[i].filter((x) => x !== undefined).length`, an array allocated
  per row per call). [src]
- Per draw the trims run more than once: `body.draw` calls
  `this._clean_rows(clean_ridx)` for each column (`tbody.ts:250`);
  `header.draw` calls `this._clean_rows(this._offset_cache.length)` for each
  column (`thead.ts:247`); `_cleanupAfterDraw` (`body.clean` + `header.clean`,
  `table.ts:334-344`) runs at the end of the pass (1015 or 1058 or 936) and
  again in `finally` (1070-1072). [src]
- Rows drawn per column: the loop over `column_data` breaks at
  `if ((ridx - overdraw) * (row_height ?? 0) > container_height)`
  (`tbody.ts:224`), `overdraw` being 1 when the row offset is fractional (95).
  At an integer offset one spare stale row is kept if its shape matches,
  rather than removed and recreated (231-248, 266-287). [src]

### 5.2 What each body cell costs per draw (`_draw_td`, `tbody.ts:30-69`)

Every visible cell is visited on every render, in column-major order
(`_drawDataColumn` per column, `table.ts:958-970`). Per cell [src]:

- `_get_cell` → `_get_row`, which returns a fresh `{ tr, row_container }`
  object (`view_model.ts:153`);
- `METADATA_MAP.get(td)` (`view_model.ts:108`), then about fifteen property
  writes on the reused metadata object: `y`, `size_key`, `column_header`
  (`tbody.ts:41-45`), `user`, `type`, `x`, `x1`, `row_header`, `y0`, `y1`, `dx`,
  `dy`, `virtual_x`, `x0` (198-213), `value` (67);
  `meta.row_header = row_headers?.[ridx] || []` allocates an empty array per
  cell when the response has no row headers (205);
- `td.classList.toggle("rt-cell-clip", clip)` unconditionally (51), then
  `_tagColumn` or `_untagColumn` (52-56), which consult `COLUMN_TAG_MAP`
  before touching `classList` (`view_model.ts:72-99`);
- the text, only if changed: `if (metadata.value !== val) { … td.textContent = String(val ?? ""); }`
  (58-65). An `HTMLElement` value is appended instead (59-61).

So the DOM *writes* are proportional to changed values, the JavaScript work to
visible cells. [inf]

### 5.3 Headers: per column, per level, on every draw

- Column headers: `header.draw` runs once per drawn data column
  (`table.ts:241`) and loops `for (let d = 0; d < header_levels; d++)`
  (`thead.ts:172`). [src]
- Group levels (`d < column_header_merge_depth`, default `header_levels - 1`,
  168-171): if `this._group_header_cache?.[d]?.[0]?.value === column_name`
  the cached `<th>` is reused and its count incremented (178-182); otherwise
  the previous group's colspan is flushed and a new cell drawn (188-195).
  `_flush_colspan` writes the attribute only if it changed
  (`if (th.getAttribute("colspan") !== val) { th.setAttribute("colspan", val); }`,
  257-272). [src]
- `_draw_group_th` (56-98) skips all DOM work when `HEADER_STATE` says the cell
  already shows this value with its two children intact (63-72); otherwise
  `th.removeAttribute("colspan"); th.textContent = "";` and re-append of a
  text `<span>` and a `<span class="rt-column-resize">`. [src]
- Unconditional per column per level:
  `this._get_row(d).tr.classList.toggle("rt-autosize", d === column_header_merge_depth)`
  and `th.classList.toggle("rt-group-corner", x === undefined)` (224-229); at
  the leaf level `th.removeAttribute("colspan")` (221), `_tagColumn`,
  `_observe_autosize`, `classList.toggle("rt-cell-clip", …)` (125-135). [src]
- The merge caches are reset after every render:
  `this.table_model.header.reset_header_cache()` (`scroll_panel.ts:443`). So a
  purely vertical step still re-runs the whole header pass (columns × levels);
  it finds nothing to write except the no-op toggles. [src] [inf for the last clause]
- Row headers: `body.draw(…, th = true, …)` loops `row_headers_length` times
  over all rows (`tbody.ts:94, 104`). A merged cell is **removed from the
  DOM**: `prev_col.setAttribute("colspan", …); this._replace_cell(ridx, cidx_i)`
  or the `rowspan` equivalent (143-154; `_replace_cell` does
  `tr.removeChild(td)`, `view_model.ts:117-128`). A non-merged header cell gets
  `td.style.display = ""; td.removeAttribute("rowspan"); td.removeAttribute("colspan");`
  every draw (168-170). [src] Scrolling through merged row headers therefore
  creates and removes `<th>` elements as groups enter and leave. [inf]

### 5.4 `getMeta`

`getMeta(element)` is `METADATA_MAP.get(element)`, a module-level
`WeakMap<HTMLElement, CellMetadata>` (`regular-table.ts:220-221`,
`view_model.ts:16`); the coordinate forms resolve a cell with `_fetch_cell`
(`this.cells[ridx]?.[cidx]`) and recurse (`regular-table.ts:222-255`). [src]
The lookup returns the same object the draw mutates in place, so it is only
valid until the next draw. [inf] Its cost is paid at draw time for every cell
(5.2), whether or not anything calls `getMeta`. [inf]

### 5.5 Style listeners

- Signature: `(event: { detail: RegularTableElement }) => void | Promise<void>`
  (`types.ts:300-302`). It receives the element only: no list of cells, no
  dirty set, no viewport. Listeners find cells with `querySelectorAll` and
  `getMeta` (`rt:README.md:450-475`). [src] [doc]
- **Commit pipeline** (normal scroll): called synchronously at each
  `"style"` yield, inside the rAF commit, **not awaited**
  (`scroll_panel.ts:319-326`: "a synchronous commit cannot await them; any DOM
  effects they defer land after this commit and are not measured by it"). The
  sub-cell offset is written just before the first call (313-317). Order
  inside the commit: cell and header writes → column rules → listeners →
  `autosize_cells` if needed → `_post_render`. [src]
- **Async pipeline**: `await style_callback()` runs **before every generator
  step**, `{ fetch }` yields included (`table.ts:742-750`:
  `while (!step.done) { await style_callback(); step = render_pass.next(step.value === "style" ? undefined : await step.value.fetch()); }`),
  and each listener is awaited in turn
  (`for (const callback of this._style_callbacks) { await callback({ detail: this }); }`,
  `scroll_panel.ts:1039-1041`). So listeners run once per continuation fetch
  ("Style the partially-renderd rows so there is no FOUT", `table.ts:904`) and
  once per `"style"` yield: 1 + k + (extra fill attempts) times per draw. [src]
- Not called at all when the integer viewport is unchanged
  (`scroll_panel.ts:307-310`, 1054-1056). [src]

## 6. The "profile-guided" changes

Both commits have empty bodies and the PR texts are not in the repository, so
this is the diff, not the author's account. What profile motivated each is not
recoverable from the tree.

### #248, v0.7.1 — `245e3ed` "Add benchmark suite and profile-guided optimizations" (`rt:CHANGELOG.md:122`)

[src: `git show 245e3ed`]

- Added `benchmarks/benchmark.html` and `benchmarks/benchmark.mjs` (the suite
  WORKLOADS.md describes) and the `bench` script.
- Sub-cell offsets: from rebuilding a stylesheet per draw
  (`this._sub_cell_style.replaceSync(cssText)` of a `:host { … }` template) to
  four `setProperty` calls on a retained `CSSStyleRule`
  (`this._sub_cell_rule.style.setProperty(CLIP_X, …)`).
- Column widths: `_applyColumnWidthStyles` returns early when the CSS text is
  unchanged (`if (css === this._lastColumnWidthCss) { return; }`) instead of
  calling `replaceSync` every draw.
- DOM trimming: `_clean_rows` and `_clean_columns` collect nodes then
  `node.remove()`, and truncate with `.length =`, replacing
  `while (this.table.children[ridx]) removeChild(…)` and `.slice()` copies.
- `_get_or_create_metadata`: one `METADATA_MAP.get` instead of `has` + `get`.
- `.reduce` closures replaced by loops in `_drawRowHeaders`, the row-header
  length scan, the column-width sums and the panel-width sums.
- One generator step removed: the `yield undefined;` after a continuation
  fetch, which had run the style listeners one extra time per fetch.
- An unused `DocumentFragment` field removed; panel sizes written with
  `toPrecision(10)`; methods reordered and made `protected`/`private`.

### #284, v0.9.0 — `82d09ec` "Profile-guided performance optimization for scrolling" (`rt:CHANGELOG.md:29`, listed under "Breaking changes")

[src: `git show 82d09ec`]

- **The scroll path was rewritten.** Before:
  `await new Promise(requestAnimationFrame);` then, after clearing
  `_scroll_pending`, `await this.draw({ invalid_viewport: false, cache: true });`
  (data awaited after the frame, DOM written whenever it resolved, later
  scroll events ignored while the rAF was pending). After: the loop of 1.4
  (`_scroll_dirty`, stored `_scroll_left`/`_scroll_top`, `predraw` then rAF
  then synchronous `commit()`), with the three client-size reads hoisted to
  the scroll event.
- **Measurement made conditional**: `_needs_autosize` gates every
  `autosize_cells` call, so the per-draw `getBoundingClientRect` pass
  disappears once the visible columns are measured; `_measured_overrides`
  tracks overrides already measured.
- **`ResizeObserver` for width growth** (`_autosize_observer`,
  `_on_autosize_entries`, `_on_autosize_change` → `_autosize_fill_check`,
  `_draw_in_flight`), replacing unconditional re-measurement.
- **Header DOM reuse**: `HEADER_STATE` with per-cell retained `span` and
  resize handle and an early return when unchanged; the pooled `ElemFactory`
  / `_span_factory` and `_carriageReturn` removed. Colspans are written once
  per group by `_flush_colspan` instead of `setAttribute` on every merged
  column.
- **Body**: the spare "overdraw" row is kept across integer/fractional offsets
  (`overdraw`, `broke`, `drawn_ridx`); `classList.toggle("rt-cell-clip", clip)`
  replaces a `contains` read followed by a toggle.
- New option `column_classes` (`rt-col-{size_key}` on every cell); `throttle`
  added to `PredrawOptions`.

Related, between the two [src: `git show 58793cd`, `d68b4e1`]: **#275, v0.8.5**
(branch `minimize-layout-thrash`) replaced the `:nth-child` width stylesheet
with one `.rt-scope-N .rt-col-K` rule per column, introduced `warm` /
`unmeasured_col_width` (one `offsetWidth` read per pass instead of one per new
column) and `_estimated_column_width`, and added `_scroll_pending` to
`flush()`. **#278, v0.8.6** added `predraw`, `draw_sync` and the shared
`_render_pass` generator.

---

# TanStack Virtual (virtual-core 3.19.11, react-virtual 3.14.26)

## 7. `getMeasurements`

### 7.1 What is built for N items (`lanes === 1`, the default)

`core:1716-1758` [src]:

```ts
const need = count * 2
let flat = this._singleLaneMeasurements?.flat
if (!flat || flat.length < need) { const next = new Float64Array(need); … flat = next }
const items: Array<Key | VirtualItem> = min === 0 ? new Array(count) : this._singleLaneMeasurements!.items.slice()
…
for (let i = min; i < count; i++) {
  const key = getItemKey(i)
  items[i] = key
  const measuredSize = itemSizeCache.get(key)
  const size = typeof measuredSize === 'number' ? measuredSize : this.options.estimateSize(i)
  flat[i * 2] = runningStart
  flat[i * 2 + 1] = size
  runningStart += size + gap
}
this._singleLaneMeasurements = { flat, items }
const view = createLazyMeasurementsView(items, flat)
this.measurementsCache = view
```

- **Not one object per item.** Per build: one `Float64Array` of 2N numbers
  (start, size), reused if large enough; one N-slot array holding keys; one
  `Proxy`. `VirtualItem` objects are created lazily by the Proxy's `get` trap
  on first indexed read and stored back into `items`
  (`tv:packages/virtual-core/src/lazy-measurements.ts:27-39`:
  `v = target[i] = { index: i, key: v, start: s, size: flat[i * 2 + 1]!, end: s + flat[i * 2 + 1]!, lane: 0 }`). [src]
  Introduced in 3.15.0: "no longer allocates a `VirtualItem` object per index
  for single-lane lists; instead it fills a `Float64Array` of start/size pairs
  and materializes `VirtualItem` objects lazily through a `Proxy`-backed view"
  (`tv:packages/virtual-core/CHANGELOG.md:319-325`). [doc]
- **The repo's benchmark README contradicts this source.** It says "we eagerly
  populate `measurementsCache` (one object per item) on every mount" and "we
  hold a `VirtualItem` object per item" (`tv:benchmarks/README.md:106-108,
  154-155`). [doc] At this tag that describes only `lanes > 1`. [src] The
  README's numbers are either from before 3.15.0 or the prose was not updated;
  the tree does not say which. [inf]
- **The loop is still eager and O(N)**: every index from `min` gets a
  `getItemKey(i)` call, an `itemSizeCache.get(key)` Map lookup and, if
  unmeasured, an `estimateSize(i)` call. There is no fast path for a constant
  estimate: `() => 35` is called N times. [src] Constant versus variable
  `estimateSize` differs only in what the callback itself costs. [inf]
- When it first runs: on the first read of anything derived from it
  (`calculateRange`, `getVirtualItems`, `getTotalSize`), i.e. during the first
  render. [inf, from the memo chain]

### 7.2 Memo dependencies and invalidation

- `getMeasurements = memo(() => [this.getMeasurementOptions(), this.itemSizeCacheVersion], …)`
  (`core:1648-1649`). `getMeasurementOptions` is itself a memo over
  `count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode, gap`
  (1597-1607) returning a new object when any changes, and it sets
  `this.pendingMin = null` (1627). [src]
- `memo` compares by identity:
  `newDeps.length !== deps.length || newDeps.some((dep, index) => deps[index] !== dep)`
  (`utils.ts:31-33`). Every call allocates a fresh deps array before
  comparing (29). [src]
- **`estimateSize` is not a dependency.** A new estimate function alone does
  not rebuild; `measure()` is needed. [src, by absence in 1598-1607]
- **`getItemKey` is a dependency by identity.** An inline `getItemKey` closure
  recreated on every render changes the deps every render and rebuilds all N
  entries from index 0 each time. [inf, from 1602 and 1627; the default
  `defaultKeyExtractor` (`core:96`) is stable]

| Invalidator | What it does | Rebuild range |
|---|---|---|
| `count` (or any option above) changes | `getMeasurementOptions` returns a new object, `pendingMin = null` | 0 … N |
| `resizeItem(index, size)` with `delta !== 0` | `if (this.pendingMin === null \|\| index < this.pendingMin) { this.pendingMin = index }`, `this.itemSizeCache.set(key, size)`, `this.itemSizeCacheVersion++` (`core:2107-2111`) | `min` … N at the next read (`const min = … (this.pendingMin ?? 0)`, 1703) |
| `measure()` | `this.pendingMin = null; this.itemSizeCache.clear(); this.laneAssignments.clear(); this.itemSizeCacheVersion++; this.notify(false)` (`core:2741-2750`) | 0 … N, all sizes back to estimates |
| `setOptions` with `anchorTo: 'end'` and changed edge keys | `this.pendingMin = 0; this.itemSizeCacheVersion++` (894-897) | 0 … N |
| `lanes` changes | caches cleared (1682-1691) | 0 … N |

[src]

- The rebuild is lazy (it happens at the next `getMeasurements()` read, not
  inside `resizeItem`), so a batch of resizes normally costs one rebuild from
  the smallest dirty index. [src, from the memo; inf for "normally"] Exception:
  inside a `ResizeObserver` batch, once one entry has adjusted the scroll
  position, every later entry rebuilds first:
  `if (this._resizeBatch?.sync) this.getMeasurements()` (`core:2040`). [src]
- A partial rebuild still copies the whole key array
  (`this._singleLaneMeasurements!.items.slice()`, 1730) and creates a new
  Proxy (1755); the copy keeps already-materialized `VirtualItem`s below `min`
  and overwrites those from `min` on with bare keys. [src]
- Resizing index *i* therefore costs O(N − i) writes plus an O(N) copy at the
  next read; the lowest indices are the most expensive. [inf]

### 7.3 `lanes > 1`

Eager objects: `measurements[i] = { index: i, start, size, end, key, lane }`
for every index (`core:1845-1852`), after
`const measurements = this.measurementsCache.slice(0, min)` (1760). Lane
choice is cached per index in `laneAssignments: Map<number, number>` (499,
1788-1835); with no cached lane the item goes to the shortest lane found by
an O(lanes) scan of `laneEnds` (1809-1821). `laneAssignmentMode: 'estimate'`
(default, 810) caches the lane at first placement; `'measured'` only once the
item has a measured size (`shouldCacheLane`, 1792-1793). [src]

## 8. Range, indexes, items

### 8.1 Algorithm

- `calculateRange = memo(() => [this.getMeasurements(), this.getSize(), this.getScrollOffset(), this.options.lanes, this._getLayoutTotalSize() + this.options.scrollMargin], …)`
  (`core:1870-1879`). The offset is clamped first:
  `Math.min(scrollOffset, maxScrollOffset)` with
  `maxScrollOffset = Math.max(listEnd - outerSize, 0)` (1888-1892). [src]
- `calculateRangeImpl` (`core:2803-2876`), single lane:
  `findNearestBinarySearchFlat(flat, lastIndex, scrollOffset)` (2782-2801), a
  binary search over `flat[middle * 2]` returning the last item whose start is
  ≤ the offset; then a forward walk
  `while (endIndex < lastIndex && flat[endIndex * 2]! + flat[endIndex * 2 + 1]! < limit) { endIndex++ }`
  with `limit = scrollOffset + outerSize` (2824-2831). O(log N) + O(visible). [src]
  The closure-based `findNearestBinarySearch` (2753-2777) serves `lanes > 1`
  and `getVirtualItemForOffset`. [src]
- **The range is the visible range, without overscan.** Overscan is applied
  only by the extractor: `const overscan = range.overscan * Math.max(range.lanes ?? 1, 1)`,
  `start = Math.max(range.startIndex - overscan, 0)`,
  `end = Math.min(range.endIndex + overscan, range.count - 1)`
  (`defaultRangeExtractor`, `core:98-113`). Default `overscan: 1` (786). [src]
- `getVirtualIndexes` (`core:1908-1942`) memoizes on
  `[rangeExtractor, overscan, count, startIndex, endIndex, lanes]` and calls
  `rangeExtractor({ startIndex, endIndex, overscan, count, lanes })`. Its deps
  function also calls
  `this.maybeNotify.updateDeps([this.isScrolling, startIndex, endIndex])`
  (1917), so a range first seen during a render does not trigger a second
  notify. [src]
- `getVirtualItems` (`core:2155-2183`) memoizes on
  `[this.getVirtualIndexes(), this.getMeasurements(), this._holdOffset]` and
  pushes `measurements[i]` for each index. [src]
- **Consequence: overscan does not reduce notifications.** `maybeNotify`
  keys on the un-overscanned `range.startIndex`/`endIndex` (`core:1021-1025`),
  so `onChange` fires whenever the first or last *visible* index changes, with
  overscan 1 or 20 alike; overscan only enlarges what is rendered each time. [inf,
  from 1017-1039 and 98-113]

### 8.2 Work and allocations per scroll event

The handler is the callback at `core:1119-1251`, entered from `createHandler`
(217-221). In order [src]:

1. `offset = readOffset(element)` → `el.scrollTop` (247); `fallback?.()` →
   `clearTimeout` + `setTimeout(…, isScrollingResetDelay)` on every event
   (`utils.ts:106-108`), unless `useScrollendEvent`.
2. `const elementMax = isScrolling ? this._elementMaxScrollOffset() : null`
   (1123) → `el.scrollHeight - el.clientHeight` (2252): **two more
   layout-dependent reads on every scroll event**.
3. `_classifyScrollEvent(…)` (1132-1136) builds an argument object and returns
   one of `spurious | readBack | clampedReadBack | clampedEcho | external`
   (`tv:packages/virtual-core/src/scroll-classifier.ts:17-22`).
   `if (kind === 'spurious') return` (1137): an event at the offset already
   held, with no write pending, is dropped before any range work.
4. Bookkeeping: `pendingWrite = null`, `scrollDirection`, `scrollOffset`,
   `isScrolling` (1163-1193); `this._iosGesture.onScroll({ … })` (1225-1236,
   another object); `this._flushHoldIfReady(true)` (1245);
   `if (this.scrollState) { this.scheduleScrollReconcile() }` (1247-1249).
5. `this.maybeNotify()` (1250) → `calculateRange()` → because `scrollOffset`
   changed, `calculateRangeImpl` runs and returns a **new** `{ startIndex, endIndex }`
   object → compare `[isScrolling, startIndex, endIndex]` → `notify(isScrolling)`
   → `this.options.onChange?.(this, sync)` (957-959) only if one changed.

Allocations [inf, counted from the code above]: with no range change, a few
short-lived arrays and objects (two memo deps arrays, one range object, the
classifier and gesture argument objects) and one timer reset; no item
objects. With a range change, when the consumer then reads
`getVirtualItems()`: one index array (`new Array<number>(len)`, `core:108`),
one `virtualItems` array (2158), and one `VirtualItem` per index entering for
the first time since the last rebuild, created in the Proxy trap, which
receives the index as a string (`typeof prop === 'string'`, `const i = +prop`,
`lazy-measurements.ts:21-25`). Items already materialized keep their identity
across renders until the next rebuild. A mouse wheel or drag also adds
nothing per item for rows that stay.

Also at mount: `observeElementRect` reads `clientWidth`/`clientHeight` once
and observes the scroll element (`core:133, 150`); `_willUpdate` ends with
`this._scrollToOffset(this.getScrollOffset())` (1261), a `scrollTo` write of
the initial offset; passive `touchstart`/`touchend`/`touchcancel` capture
listeners are attached on every platform
(`tv:packages/virtual-core/src/ios-gesture.ts:191-201`). [src]

## 9. Dynamic measurement

### 9.1 `measureElement` → `ResizeObserver` → `resizeItem`

- The instance method `measureElement(node)` (`core:1990-2029`), used as a
  ref: reads `data-index` (`indexFromElement`, `node.getAttribute(attributeName)`
  + `parseInt`, 1944-1956), registers the node in `elementsCache` and with the
  observer (`observer.observe(target, { box: 'border-box' })`, 750). Then it
  measures **synchronously only when idle or during a programmatic scroll**:
  `if (node.isConnected && (!this.isScrolling || this.scrollState) && this.shouldMeasureDuringScroll(index)) { this.resizeItem(index, this.options.measureElement(node, undefined, this)) }`
  (2022-2028). [src] "During normal user scrolling, skip sync measurement — the
  RO callback handles it async" (2017). [doc]
- The option default, module function `measureElement(element, entry, instance)`
  (`core:258-301`): with an entry,
  `Math.round(box[instance.options.horizontal ? 'inlineSize' : 'blockSize'])`
  from `entry.borderBoxSize[0]`, no layout read; without an entry, the cached
  size if the key has one ("avoids a synchronous layout read", 285), else
  `element.offsetHeight` / `offsetWidth` (298-300). [src] So a synchronous
  `offsetHeight` happens only for a never-measured row mounted while idle or
  during `scrollToIndex`. [inf] Sizes are rounded to whole pixels. [src]
- `measureElement(null)` (a ref detaching) walks the whole `elementsCache`
  and drops disconnected nodes (1991-1998), once per detaching row. [src]
- Observer callback (`core:669-704`): opens a batch
  (`this._resizeBatch = batch`), runs `entries.forEach(measureEntry)`, then
  `if (batch.notify) { this.notify(batch.sync); this._noteClampMax(); this._flushHoldIfReady(true); this._retryClampedAdjustment(); this.measureElement(null) }`
  (678-691). **One notify per observer delivery**, not per entry. With
  `useAnimationFrameWithResizeObserver` the whole batch is deferred to a rAF
  (694-695). [src]
- `measureEntry` (707-735) skips disconnected nodes and, during a smooth
  programmatic scroll, rows outside a window around the target
  (`shouldMeasureDuringScroll`, 1963-1988). [src]

### 9.2 `resizeItem(index, size)` (`core:2031-2153`): when it re-notifies, when it writes the scroll position

- `const itemSize = this.itemSizeCache.get(key) ?? cachedSize; const delta = size - itemSize`;
  nothing happens if `delta === 0` (2061-2064). A row whose measured size
  equals the estimate never notifies. [src]
- Otherwise it marks the cache dirty (7.2) and decides on a scroll write.
  Default rule (2074-2087): first measurement → `itemStart < scrollOffset`;
  re-measurement → `itemStart + itemSize <= scrollOffset && this.scrollDirection !== 'backward'`.
  It is replaced, not combined, when the **instance property**
  `shouldAdjustScrollPositionOnItemSizeChange(item, delta, instance)` is set
  (`core:639-645`, used at 2090-2105); it is not a constructor option. No
  adjustment while a smooth scroll runs (`!isSmoothScroll(this.scrollState)`,
  2089) or while a command's write has not been read back
  (`if (!this._awaitingCommandReadBack())`, 2117). With `anchorTo: 'end'` and
  the viewport at the end, the adjustment is the change in total size instead
  (2065-2069, 2118-2121). [src]
- The write: `applyScrollAdjustment(delta)` (965-1015) →
  `this._scrollToOffset(offset, { adjustments: delta, behavior })` →
  `scrollToFn(offset - this._holdOffset, { behavior, adjustments }, this)`
  (2692-2696) → `elementScroll` = `scrollWithAdjustments`:
  `scrollElement?.scrollTo?.({ top: adjustedOffset, behavior })` with
  `adjustedOffset = offset + adjustments` (303-328). It is a synchronous
  `scrollTo` inside the observer callback, and
  `if (this.pendingWrite === write) this.scrollOffset += delta` (1004) updates
  the tracked offset at once. [src]
- **`scrollAdjustments` no longer accumulates anything**:
  `get scrollAdjustments() { return 0 }`, "@deprecated Always 0: a scroll
  correction is folded into `scrollOffset` at once" (`core:516-523`). [src]
  [doc] The `adjustments` argument to `scrollToFn` is still passed.
- The notify: inside a batch it only sets
  `this._resizeBatch.notify = true; this._resizeBatch.sync ||= adjustedSync`
  (2137-2143); outside a batch `this.notify(adjustedSync)` immediately (2144).
  `sync` is true exactly when a scroll write (or a held correction) happened,
  so that "the grown item transforms … commit in the SAME frame as that write"
  (2127-2136, issue #1227). [src] [doc]
- When a write is impossible (iOS touch in progress, or overscrolled:
  `_canWriteScroll`, 1414-1415) the delta goes into `_holdOffset` and every
  item is exposed shifted by it (`start: measurement.start - hold`, 2166-2173)
  until `_flushHoldIfReady` (1424-1446). Not reachable on desktop Chrome
  unless the last scroll event reported an overscrolled position. [src] [inf
  for the last sentence]
- A write the browser clamps because the sizer has not grown yet is recorded
  (`_clampedAdjustment`, 637-638, 989) and re-issued by
  `_retryClampedAdjustment` (1346-1364). [src]

### 9.3 How `scrollToIndex` converges

- `scrollToIndex(index, { align, behavior })` (`core:2441-2456`) computes the
  target from current measurements (`getOffsetForIndex`, 2386-2427) and calls
  `_startScroll` (2507-2584), which stores a `scrollState`
  (`index, align, startedAt, lastTargetOffset, stableFrames: 0, phase`),
  writes once (`this._scrollToOffset(offset, { behavior })`) and calls
  `scheduleScrollReconcile()`. [src]
- `scheduleScrollReconcile` (1449-1459) holds at most one pending frame:
  `if (this.rafId != null) return; this.rafId = this.targetWindow.requestAnimationFrame(() => { this.rafId = null; this.reconcileScroll() })`. [src]
- `reconcileScroll` (1468-1569), each frame: rebuild measurements
  (`this.getMeasurements()`, 1491); recompute the target
  (`getScrollStateTarget`, 1460-1467); if the target is unchanged and
  `approxEqual(targetOffset, this.getScrollOffset())` (within 1.01 px,
  `utils.ts:97`) then `stableFrames++`, and at
  `STABLE_FRAMES` (1 for an offset target, **2 for an index target**, 3 with
  `useAnimationFrameWithResizeObserver`; 1498-1503) it writes the exact target
  if needed and clears the state (1516-1527). Otherwise `stableFrames = 0`
  and, if the target moved, it writes again
  (`this._scrollToOffset(targetOffset, { behavior: keepSmooth ? 'smooth' : 'auto' })`,
  1559-1561). It **always** reschedules while the state exists (1568). [src]
- Limits: no retry count. One safety valve by time:
  `const MAX_RECONCILE_MS = 5000` (1475-1479). A user scroll retires the
  command (`externalRetiresCommand`, 1153-1162); `cancelScroll()` drops it
  (2590-2596). [src]
- So a jump into unmeasured rows is a per-frame loop: write → scroll event →
  render the new rows → refs measure them synchronously (9.1, because
  `this.scrollState` is set) or the observer does → sizes change the target →
  next frame's `reconcileScroll` writes again → until two consecutive frames
  agree. Each lap is one rAF plus the consumer's render. [inf, assembled from
  the steps above]

## 10. The React adapter

### 10.1 What `useVirtualizer` does

`useVirtualizer` → `useVirtualizerBase` (`react:76-284`, 286-301). [src]

- Every render: `const rerender = React.useReducer((x: number) => x + 1, 0)[1]`
  (88), a fresh `resolvedOptions = { ...options, onChange }` (175-221),
  `instance.setOptions(resolvedOptions)` (259), which rebuilds the merged
  options object from about 28 defaults (`core:783-817`). The instance is
  created once in `React.useState(() => …)` (223). [src]
- Layout effects after every commit: `applyContainerSize(instance); return instance._willUpdate()`
  (265-274), then `applyDirectStyles(instance)` (279-281); mount only:
  `instance._didMount()` (261-263). The scroll listener and observers are
  attached in `_willUpdate` when the scroll element first appears
  (`core:1091-1262`). [src]
- **On each `onChange(instance, sync)`** (`react:177-220`):

  ```ts
  let shouldRerender = true
  if (state.enabled) { applyDirectStyles(instance); shouldRerender = !prev || prev.isScrolling !== instance.isScrolling || prev.startIndex !== range?.startIndex || prev.endIndex !== range?.endIndex; … }
  if (shouldRerender) {
    if (useFlushSync && sync && !measuringFromRef.current) { flushSync(rerender) } else { rerender() }
  }
  options.onChange?.(instance, sync)
  ```

  `flushSync` is used when all three hold: `useFlushSync` (default `true`,
  line 80), the notify is synchronous, and it did not come from a ref callback
  (`measuringFromRef`, set around `measureElement` at 226-232, because
  "`flushSync` cannot flush there", 204-211). [src] [doc]
- `sync` for a scroll-driven notify is `isScrolling`
  (`core:1027-1028`: `(isScrolling) => { this.notify(isScrolling) }`). So
  **a range change during scrolling renders React synchronously inside the
  scroll event** (`flushSync(rerender)`: render, commit and layout effects
  before the handler returns), and the notify that ends scrolling
  (`isScrolling` false, after 150 ms) uses plain `rerender()`. [src; the
  description of `flushSync` is inf from React's documented behaviour]

### 10.2 Renders per scroll event

[inf, from 8.1, 8.2 and 10.1]

- Scroll event that changes neither the visible first/last index nor
  `isScrolling`: **0** renders.
- First scroll event of a gesture (`isScrolling` false → true) and each event
  that changes the visible range: **1** synchronous render.
- About 150 ms after the last event: **1** more, asynchronous, for
  `isScrolling` → false.
- With measured rows (`ref={virtualizer.measureElement}`): after the commit
  the browser delivers the `ResizeObserver` batch; if any row's size differs
  from its cached or estimated size there is **1** more notify per delivery,
  `flushSync` if a scroll adjustment was written, plain `rerender()` otherwise
  (9.2). Rows whose size matches cause none.
- Examples wrap the app in `<React.StrictMode>`
  (`tv:examples/react/fixed/src/main.tsx:217`, `table/src/main.tsx:202`,
  `dynamic/src/main.tsx:457`) [src]; in a development build React
  double-invokes component functions, so trace a production build to count
  renders. [inf]

### 10.3 `useFlushSync` and `directDomUpdates`

- `useFlushSync: false` makes every notify use `rerender()` (`react:212-216`).
  [src] The doc's reason to disable it is a React 19 warning and "performance
  issues with rapid scrolling on lower-end devices"; with it off the changelog
  warns of "potentially increased visible whitespace during fast scrolling
  with dynamically sized items" (`tv:docs/framework/react/react-virtual.md:38-64`,
  `tv:packages/react-virtual/CHANGELOG.md:287-292`). [doc]
- `directDomUpdates: true` (default `false`, line 81; present at this
  version) with `containerRef` on the sizer: on every notify the adapter
  writes the sizer's `height` (`applyContainerSize`, 122-134, guarded by
  `lastSize`) and each rendered row's position (`applyItemPosition`, 138-155,
  guarded by a `WeakMap` of last positions), as
  `` el.style.transform = `translate3d(0, ${next}px, 0)` `` in the default
  `'transform'` mode or `el.style.top` in `'position'` mode. It re-renders
  only when the range or `isScrolling` changed (187-191). [src]
- **What it actually saves.** Scroll-driven notifies already fire only on a
  range or `isScrolling` change (`maybeNotify`), and exactly those still
  re-render. The notifies it turns into direct style writes are the
  measurement ones (`resizeItem`, observer batches, `measure()`), where sizes
  and positions change but the range does not. [inf, from 187-191 and
  `core:1017-1029`] The doc phrases it as "Skip React re-renders for
  scroll-only updates" (`react-virtual.md:81`). [doc] The e2e test's
  comment "Scroll by exactly one item — does NOT change the visible range
  (overscan absorbs it)" (`tv:packages/react-virtual/e2e/app/test/direct-dom-updates.spec.ts:44-45`)
  does not match 8.1, where a one-item scroll changes `startIndex`; the test
  only asserts at most two extra renders, which holds either way. [doc] [inf]
- If `containerRef` is omitted, direct writes are skipped but re-renders are
  still suppressed (`if (!state.enabled || !state.container) return`,
  `react:165`; `react-virtual.md:92`). [src] [doc]

### 10.4 What the three examples put in a trace

All three: React ^19.2.7, `@tanstack/react-virtual` ^3.14.26, StrictMode. [src:
each `package.json`] Element counts below are [inf] arithmetic from the styles.

**`examples/react/fixed`** (`src/main.tsx`): three scrollers on one page.

- Rows (42-90): `count: 10000`, `estimateSize: () => 35`, `overscan: 5`; a
  200 × 400 px `overflow: auto` div; sizer
  `` height: `${rowVirtualizer.getTotalSize()}px` ``, `position: relative`;
  each row one `<div key={virtualRow.index}>` with text `Row {index}`, style
  `position: absolute; top: 0; left: 0; width: 100%; height: ${size}px; transform: translateY(${start}px)`.
  No `measureElement`. About 6-7 visible + 10 overscan ≈ 17 row divs.
- Columns (92-143): the same horizontally, `estimateSize: () => 100`.
- Grid (145-213): **two virtualizers on one scroll element** (rows 35 px,
  columns 100 px, 10,000 × 10,000, overscan 5 each), a 500 × 500 px scroller;
  one `<div>` per cell inside `<React.Fragment key={virtualRow.key}>`, text
  `Cell {row}, {column}`, `transform: translateX(…) translateY(…)`. About
  26 × 16 ≈ 400 cell divs. Each virtualizer has its own scroll listener and
  its own `flushSync`; a vertical scroll reaches the column virtualizer's
  handler too, where an unchanged `scrollLeft` is classified `spurious`
  (8.2 step 3). [src for structure; inf for the last clause]
- Per range change: React re-renders the whole component; because rows are
  keyed by index and their style depends only on the index, kept rows get no
  DOM writes, and entering/leaving rows are created/removed. [inf, from keyed
  reconciliation; no `React.memo`, no pooling]

**`examples/react/dynamic`** (`src/main.tsx`): four variants by `location.pathname` (396-438).

- `/` (16-110): 10,000 faker sentences of 20-70 words (12-14);
  `estimateSize: () => 45`, default overscan 1, **`directDomUpdates: true`**
  (27); scroller 400 × 400 with `contain: 'strict'`, `overflowAnchor: 'none'`
  (71-77); sizer has `ref={virtualizer.containerRef}` and no height in JSX
  (79-85); each row `<div key={v.key} ref={virtualizer.measureElement} data-index={v.index}>`
  with `position: absolute; top: 0; left: 0; width: 100%` and **no transform
  in JSX** (the adapter writes `translate3d`), containing a padded div with
  two text divs (87-104). On mount:
  `React.useEffect(() => { virtualizer.scrollToIndex(count - 1, { align: 'end' }) }, [])`
  (30-32), so **page load already contains the 9.3 reconcile loop** jumping
  to the end of an unmeasured list. Buttons: top; middle with
  `behavior: 'smooth'`; end; enable toggle.
- `/columns` (112-162): horizontal, measured, positions in JSX
  (`translateX`), no `directDomUpdates`.
- `/grid` (170-266): `useWindowVirtualizer` for 300 rows (`estimateSize: () => 350`,
  overscan 5, measured) × a horizontal `useVirtualizer` over 30 columns of
  known random width 75-300; rows are flex containers with spacer divs
  `before`/`after`; cells hold 1-10 lines of faker text.
- `/experimental` (292-394): user `onChange` writes
  `innerRef.current!.style.height` and each row's `style.transform` directly
  (305-312), rows rendered from `getVirtualIndexes()`, `virtualizer.measure()`
  on mount (317-319).

**`examples/react/table`** (`src/main.tsx`): TanStack Table 8.21 + one virtualizer.

- `makeData(50_000)` (64); `useReactTable` with `getSortedRowModel()` and
  `debugTable: true` (66-76); `count: rows.length`, `estimateSize: () => 34`,
  **`overscan: 20`**, no `measureElement` (82-87). [src]
- A real `<table>` in `.container { height: 600px; overflow: auto; overflow-anchor: none; }`
  with `thead { position: sticky; top: 0; }`
  (`tv:examples/react/table/src/index.css:16-30`). Rows cannot be absolutely
  positioned, so the window is held in place by two **spacer rows**:
  `<tr><td colSpan={columnCount} style={{ height: paddingTop }} /></tr>` above
  and the same with `paddingBottom` below, where
  `paddingTop = virtualRows[0].start` and
  `paddingBottom = virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end`
  (91-98, 141-145, 163-167). There is no sizer div. [src]
- Each row: `<tr key={row.id} style={{ height: `${virtualRow.size}px` }}>` with
  eight `<td key={cell.id}>` rendered through `flexRender` (146-161); the last
  column's cell is `info.getValue<Date>().toLocaleString()` (56-58). About
  18 visible + 40 overscan ≈ 58 rows ≈ 460 `<td>`. [src; counts inf]
- Per range change: the whole table component re-renders with no memoization,
  so `flexRender` and `toLocaleString()` run for every rendered row, not only
  entering ones; the DOM changes are the two spacer heights plus entering and
  leaving rows, inside an auto-layout table. Because `maybeNotify` ignores
  overscan (8.1), this happens for every 34 px of scroll. [inf]
- A header click sorts 50,000 rows and changes row order while
  `count` stays the same. [src for the handler at 121; inf for the rest]

## 11. Scroll extent

- **No cap and no re-mapping.** The only upper-case limit constant in
  `packages/virtual-core/src` is `MAX_RECONCILE_MS`; nothing clamps or scales
  the total. [src, by search]
- `getTotalSize = () => Math.max(this._getLayoutTotalSize() - this._holdOffset, 0)`
  (`core:2601-2602`); `_getLayoutTotalSize` is the last item's
  `flat[lastIdx * 2]! + flat[lastIdx * 2 + 1]!` minus `scrollMargin` plus
  `paddingEnd` (2604-2643). Plain CSS pixels in a double. [src]
- What it feeds internally: the range clamp (`calculateRange` deps and
  `maxScrollOffset`, 1878, 1888), `getVirtualDistanceFromEnd` (2336-2349), and
  the end-anchoring delta in `resizeItem` (2069, 2120). Scroll targets are
  clamped not by it but by the **element's** real range:
  `getMaxScrollOffset = () => (this._elementMaxScrollOffset() ?? 0) + this._holdOffset`
  (2225-2226), used by `getOffsetForAlignment` (2381-2383). [src]
- Where the consumer puts it: a sizer's main-axis size.
  `fixed/src/main.tsx:65` `` height: `${rowVirtualizer.getTotalSize()}px` ``;
  with `directDomUpdates` the adapter writes
  `` state.container.style[sizeAxis] = `${totalSize}px` `` (`react:132`); the
  table example folds it into the bottom spacer row (`table/src/main.tsx:96`). [src]
- So if the browser limits the sizer's used height, `scrollTop` cannot reach
  the rows beyond it, `scrollToIndex` targets clamp to the element's maximum,
  and those rows are unreachable; the library does nothing about it. [inf,
  from the two bullets above; what Chrome does at its limit is not in this
  source]

## 12. The repo's benchmark harness

`tv:benchmarks/src/lib/harness.ts`. [src]

- Drive (`measureScrollFps`, 82-120), for the `scroll-to-bottom` action with
  `target = Math.max(0, total - container.clientHeight)` (174-177) and
  `durationMs = 1500`:

  ```ts
  while (performance.now() - startT < durationMs) {
    const elapsed = performance.now() - startT
    const t = Math.min(elapsed / durationMs, 1)
    el.scrollTop = startOffset + (targetOffset - startOffset) * t
    await nextFrame()          // new Promise((resolve) => requestAnimationFrame(resolve)), 45-47
  }
  ```

  One `scrollTop` assignment per animation frame, linear in elapsed time. No
  wheel, touch or keyboard input, and no compositor-initiated scroll. [src]
  [inf for the last sentence]
- Frame gaps come from a second rAF chain:
  `const onFrame = (t: number) => { frames.push(t - lastT); lastT = t; if (!stop) requestAnimationFrame(onFrame) }` (93-97).
- The three numbers (113-119):

  ```ts
  const longFrames = frames.filter((f) => f > 32).length
  const jankMs = frames.filter((f) => f > 50).reduce((s, f) => s + f, 0)
  const avgFrame = frames.length ? frames.reduce((s, f) => s + f, 0) / frames.length : 0
  const fps = avgFrame > 0 ? 1000 / avgFrame : 0
  ```

  `scrollFps` is 1000 ÷ mean rAF gap; `longFrames` counts gaps over 32 ms;
  `jankMs` sums gaps over 50 ms in full (not the excess over 50).
- They measure rAF cadence on the main thread, not presented frames; a frame
  the compositor drops or a long raster does not appear unless it delays the
  next rAF. [inf]
- Speed: the two scroll scenarios are 10,000 items of 30 px
  (`tv:benchmarks/src/scenarios/types.ts:109-122`), about 300,000 px in 1.5 s,
  i.e. roughly 3,300 px or 110 rows per 60 Hz frame against a 600 px scroller
  (`.scroll-host { height: 600px; width: 600px; overflow: auto; }`,
  `tv:benchmarks/index.html:16-19`), so every frame replaces the whole
  window. [inf arithmetic] For the dynamic scenario the target is the total at
  the start, computed from estimates. [inf, from 174-175]
- The TanStack page under test: `estimateSize: () => scenario.itemSize`,
  `overscan: 5`, rows `<div key={vi.key} data-index={vi.index}>` with
  `transform: translateY(${vi.start}px)`, `ref` = `virtualizer.measureElement`
  only when `scenario.dynamic` (`tv:benchmarks/src/pages/TanstackPage.tsx:30-35, 76-95`). [src]

---

# Side by side

| | regular-table 0.9.2 | TanStack Virtual 3.19.11 (core; React adapter where noted) |
|---|---|---|
| **Who owns the DOM** | The library: scroller (the host element), spacer, sticky clip, `<table>`, every `<tr>/<th>/<td>`. You supply values and may restyle cells in a style listener. [src §3.1, §5] | You: scroller, sizer, every row. The library holds numbers and writes only `scrollTo` (and, with `directDomUpdates`, the sizer size and row positions). [src §9.2, §10.3] |
| **When your code is called, relative to the scroll event** | Data listener: called in the scroll event's task (after microtask hops) when no draw is in flight; otherwise after the draw in flight commits. Style listener: inside the rAF commit, after the data resolved. [src §1.4; timing inf] | `onChange` (your render): synchronously inside the scroll listener, only when the visible first/last index or `isScrolling` changed. [src §8.2] |
| **Sync or async** | Async by construction: `await` data, `await` rAF, then a synchronous commit. Fallback path awaits data and writes with no rAF. [src §1.1, §1.4] | Sync. React: `flushSync(rerender)` while scrolling; plain `rerender()` for the end-of-scroll notify and for measurement notifies that wrote no scroll position. [src §10.1] |
| **What is rewritten per step** | Every visible cell and header cell is visited by position; `textContent` only where the value differs; metadata for every cell; panel height; four custom properties on `<table>`. Rows are never moved. [src §5.2, §5.3] | Whatever the consumer does. React examples: entering rows created, leaving rows removed, kept rows untouched (keyed); the table example also rewrites two spacer heights and re-renders all rows' React elements. [inf §10.4] |
| **What the screen shows while late** | The previous rows, frozen: the table is sticky and its sub-row offset changes only at commit; the scrollbar thumb moves. No blank area. [inf §3.3] | The browser scrolls the already-rendered rows; past the overscan there is empty sizer until the main thread renders. Data lateness is the consumer's (placeholders). [inf §8.1] |
| **Data-request policy** | Pull, by rectangle, async: exactly the visible rows `floor(start)…ceil(end)`, no overscan; columns exact + 1 on the commit path, estimated then extended on the async path. 0 calls if the integer viewport is unchanged; one draw in flight; latest position wins; no cancellation of the superseded one. [src §2, §1.5] | None. The library never asks for data; it reports a range. [src, by absence] |
| **Measurement / auto-size policy** | Row height: one value, probed once (or given by the listener). Column widths: measured from the DOM on first sight, cached per column as a grow-only `min-width`, re-measured only on a `ResizeObserver` report or after `resetAutoSize()`. [src §4] | Item sizes: `estimateSize(i)` for all N at build; optional per-row `ResizeObserver` measurement, cached by key, with scroll-position compensation for sizes above the viewport. [src §7, §9] |
| **Scroll-extent strategy** | Spacer capped at 10,000,000 px (5,000,000 in Firefox); scrollTop mapped to rows proportionally at all sizes. [src §3.1, §3.2] | Raw total in CSS pixels, no cap, no mapping; targets clamp to the element's real scroll range. [src §11] |
| **Update path (data changed, no scroll)** | You call `draw()`: a `(0,0,0,0)` dimension call, the window call, then the same positional pass; changed texts are written in a microtask after the data resolves, not in rAF. `draw({ cache: true })` skips the dimension call. Queued calls coalesce to one. [src §2.1; coalescing inf §1.3] | Nothing in the library: re-render your rows. If `count` changes, `setOptions` → full `getMeasurements` rebuild (O(N)); if sizes change, the observer path of §9; `measure()` discards all measured sizes. [src §7.2] |

# Not determined

- **Why** #248 and #284 made each change: commit bodies are empty and the PR
  descriptions are not in the repository; I did not fetch them. Section 6 is
  the diff only.
- Whether the benchmark README's "one object per item" numbers predate the
  3.15.0 rewrite: the shallow clone has no history and the README is undated
  apart from "2026-06-21" for one table (`tv:benchmarks/README.md`).
- Every "forced layout" and every frame-timing statement (same-frame commit
  with a synchronous listener; when React runs a non-`flushSync` `rerender()`
  relative to paint; whether `scrollHeight`/`clientHeight` reads in the
  TanStack scroll handler recalculate anything). The source shows the reads
  and the order; a trace has to show the cost.
- How V8 labels the class-field arrows (`notify`, `resizeItem`, `_willUpdate`)
  and the anonymous memo bodies in JS samples; section 0 gives what the source
  guarantees (named function declarations) and what it does not.
- What Chrome does when a TanStack sizer exceeds the engine's maximum element
  height; regular-table's cap value is in source, the browser limit is not.
- The mangled-to-original name map for regular-table's `dist` bundle (it needs
  the shipped source map; not decoded here).
- regular-table behaviour in Firefox/WebKit beyond the two branches read
  (`BROWSER_MAX_HEIGHT`, the Safari-only `mousewheel` path).
