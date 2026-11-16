# Writing a course page

A course page is one HTML file at the repository root, built from the shared
`assets/course.css` and `assets/course.js`. Start from `lab/page-template.html`
(head, bar, rail, intro, one step). The body is a list of steps; `course.js` adds navigation, the
side rail and everything driven by data.

The lesson shape is the one of `walkthrough.html` and of Tablelab's
`notes/trace-reading.html`: **each step holds one question**, shows what was
done and what was seen, names the source file that explains it, and ends with
what may and may not be concluded and the next question.

## A step

```html
<section class="step" data-part="B · Budget" data-title="Half the frames lose the main thread"
         data-node="frame compositor"            <!-- rail: which pipeline nodes this step is about -->
         data-ask="half|Why exactly every second frame?">   <!-- opens a held question (id|text) -->
  <p class="holding"><span class="label">Question I hold</span><span>…</span></p>

  <div class="predict" data-right="b"><span class="label">Predict first</span>
    <p>…</p>
    <div class="opts"><button data-k="a">…</button><button data-k="b">…</button><button data-k="c">…</button></div>
    <div class="reveal"><p>…</p></div>
  </div>

  <div class="beat"><span class="label">What I do</span><div><p>…</p></div></div>
  <div class="tracelink" data-trace="f-budget-250">In Perfetto: pin the <code>Compositor</code> and <code>CrRendererMain</code> threads of the Renderer process.</div>
  <div class="lanes" data-lanes='{"traces":["f-budget-250"],"from":300,"to":420,"rows":["frames","mainFrames","main","app"],"pins":[[1,316.7,"frames"],[2,322,"main"]]}'></div>
  <ol class="pins"><li><i>1</i>…</li><li><i>2</i>…</li></ol>
  <div class="beat"><span class="label">What I see</span><div><p>… <b data-m="f-budget-250/frames.partial"></b> …</p></div></div>
  <div class="beat"><span class="label">What I think</span><div><p>…</p></div></div>

  <div class="boxes">
    <div class="box file"><span class="label">File I am reading, and why</span>
      <a class="path" href="https://source.chromium.org/…">cc/scheduler/scheduler_state_machine.cc:1384</a>
      <p>Why this file answers the question.</p>
<pre><span class="n">1384</span>  <mark>decisive line</mark></pre>
    </div>
    <div class="box"><span class="label">Knowledge I am using</span><dl><dt>Term</dt><dd>Plain-words meaning.</dd></dl></div>
  </div>

  <div class="beat conclude"><span class="label">May conclude</span><div><p><b>Yes:</b> …</p><p><b>No:</b> …</p></div></div>
  <div class="hard"><span class="label">Hard learning</span><p>What I believed, what the trace showed, the rule I keep.</p></div>
  <div class="insight"><span class="label">For a table engine</span><p>The design consequence, stated as a proposal.</p></div>
  <div class="try"><span class="label">Try it</span>One thing to do in Perfetto, DevTools, the lab page or with <code>q.mjs</code>, with the expected result.</div>

  <ul class="add" hidden>
    <li data-kind="measured">One-sentence finding (joins the rail's ledger).</li>
    <li data-kind="read">…</li><li data-kind="inferred">…</li><li data-kind="rejected">…</li>
  </ul>
  <p class="next" data-answer="half"><b>Next question →</b> …</p>   <!-- data-answer closes the held question -->
</section>
```

Not every step needs every block. A step needs: the held question, evidence
(a chart, a table, a code excerpt or a trace to open), what is seen, a
conclusion with its limit, ledger items, and the next question.

## Data-driven parts

All of these read `data/index.js` (every scenario's metrics) or
`data/<id>.js` (lanes of one trace). List the fields with
`node harness/q.mjs <id> summary`.

| Markup | What it shows |
|---|---|
| `<b data-m="ID/path.to.metric"></b>` | one number, e.g. `f-budget-250/frames.partial`, `j-fmt-locale/main.scriptMs`, `s-msg-2000-tanstack/ticks.ageOnScreen.p95`, `ID/state.counters.cellsWritten`, `ID/app.draw.p50` (app measures are keyed by name without the `app: ` prefix) |
| `<table class="mtable" data-rows="id,id" data-names="label,label" data-head="Scenario" data-cols="frames.all\|with main,frames.partial\|without main,main.scriptMs\|script\|ms"></table>` | a metric table; a column is `path\|label\|unit` |
| `<div class="bars" data-bars='{"ids":[…],"labels":[…],"series":[{"path":"main.scriptMs","label":"script","color":"#d9a800"}],"stack":true,"unit":"ms","title":"…","line":16.7,"lineLabel":"one frame"}'></div>` | horizontal bars over scenarios |
| `<div class="prof" data-prof="ID" data-top="8" data-by="self"></div>` | top JavaScript functions by sampled self (or total) time |
| `<div class="lanes" data-lanes='{…}'></div>` | thread lanes; see below |
| `<div class="tracelink" data-trace="ID">optional viewer hint</div>` | download and Perfetto links for the raw trace |

Lane chart spec: `traces` (ids, stacked top to bottom), optional `titles`,
`from`/`to` in ms, `rows`, `pins` as `[number, ms, row, traceIndex]`,
`counters` (names of backend counter series to draw as line rows, for example
`"rows queue"`, `"ticks socket buffered bytes"`, `"netem queued bytes (to page)"`,
`"psp requests in flight"`).

Rows: `inputs`, `browser`, `compositor`, `frames` (one box per vsync: green =
presented with the main thread's update, amber = presented without the pending
main update, red = dropped, grey = no update wanted), `mainFrames`
(BeginMainFrame sent → commit), `tasks`, `main` (expands to `main.js`,
`main.layout`, `main.paint`), `gc`, `app` (our `performance.measure` spans,
plus ◆ content-complete and ┃ request marks), `marks`, `worker`, `io`, `raster`,
`viz`, `backendIo`, `backendQuery`, `backendTicks`, `netem`, `psp`.

Pin positions and time windows are written by hand: find them with
`node harness/q.mjs <id> frames|tree|slices|marks …`, which prints times on the
chart's axis.

## Rules for claims

- **Numbers come from data.** A number that could change when a trace is
  re-recorded is a `data-m` binding, a table or a chart. Plain numbers in prose
  are allowed for values read once from a specific trace (a timestamp, a count
  in one frame) and for arithmetic shown in the text.
- **Tag what is established** in the ledger: `measured` (in these traces),
  `read` (in source at the pinned revision, with `path:line`), `inferred`
  (reasoning from the two), `rejected` (a belief the trace contradicted).
- **Cross-check with source.** A mechanism is explained by a source excerpt at
  the pinned revision: Chromium `73c14f6` (M154), V8 `671f7c2`, DevTools
  `66df492`, TanStack virtual-core 3.19.11 (`11b48e4`), react-virtual 3.14.26,
  regular-table 0.9.2 (`52e86bf`), Perspective 5.9.2 (`0264ec1`). Quote the
  decisive lines with their line numbers.
- **One run is one run.** Each scenario was recorded once, headless, with
  tracing on. Say "in this recording"; use `f-variance` to show how much
  repeat runs move.
- **May conclude / may not.** Every step that draws a conclusion states its
  limit.
- Plain words before compressed terms; a term is introduced in "Knowledge I am
  using" the first time it is needed.

## Recording

```sh
cd lab && npm ci && npm run build
node harness/record.mjs f-budget          # ids starting with f-budget
node harness/analyze.mjs                  # rebuild data/index.js
node harness/q.mjs f-budget-250 frames 300 420
```

A scenario is an entry in `harness/scenarios.mjs`: page query, viewport, CPU
throttle, netem settings, and a list of input actions. Record one scenario at
a time on a quiet machine; two recordings at once disturb each other.

Repeated runs: `<table class="mtable runs" data-runs="f-variance" data-cols="main.scriptMs|script|ms,frames.partial|frames without main"></table>`
shows min, median and max of each metric over the runs recorded with
`runs: N` (kept in `data/runs.jsonl`).

## Checking a page

```sh
node lab/harness/check-page.mjs frames.html                      # bindings, charts, trace files, console errors
node lab/harness/check-page.mjs frames.html --shots /temp/shots   # plus a screenshot of every step, to look at
```
