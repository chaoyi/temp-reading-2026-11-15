# Table engines under load: a traced course

A table scrolls, updates arrive, the network misbehaves. What runs, on which
thread, and which frames does the user get?

Eleven modules answer that from real Chrome traces of three table
implementations — [TanStack Virtual](https://tanstack.com/virtual),
[regular-table](https://github.com/finos/regular-table) and
[Perspective](https://perspective-dev.github.io) — each checked against the
source of the libraries and of Chromium. Every trace is in this repository,
to open in Perfetto or DevTools next to the page.

**Read it:** <https://chaoyi.github.io/temp-reading-2026-11-15/> (or open
`index.html` from a clone; the pages work from disk).

| | Module | Page |
|---|---|---|
| 1 | Where does a scroll go? Trace anatomy, compositor and main thread, one frame's order, the two libraries taking one input | `walkthrough.html` |
| 2 | What happened to each frame? Frame outcomes, budgets, observation points, the observer effect, variance | `frames.html` |
| 3 | Three designs, read in source | `anatomy.html` |
| 4 | What JavaScript costs per frame | `javascript.html` |
| 5 | Style, layout, paint, compositing | `rendering.html` |
| 6 | One trace, two processes: WebSocket request/response and queues | `backend.html` |
| 7 | Live updates: three paces, data age, conflation, the scheduler | `streaming.html` |
| 8 | Congestion and extreme latency | `network.html` |
| 9 | Perspective end to end | `perspective.html` |
| 10 | The libraries' own showcases and benchmarks | `showcases.html` |
| 11 | Diagnose these traces; study design; synthesis | `clinic.html` |

Each step holds one question, shows the trace evidence (a thread-lane chart
drawn from the trace, a table of numbers read from it, or the trace itself to
open), names the source file that explains it, and states what may and may
not be concluded. Steps marked *Hard learning* record a belief the trace
contradicted.

## Layout

| Path | What |
|---|---|
| `index.html`, `*.html` | the course pages |
| `assets/course.css`, `assets/course.js` | shared page style and behaviour (navigation, rail, charts and numbers bound to data) |
| `traces/<id>.json.gz` | the raw traces: Chrome JSON trace format, gzipped, with the backend's spans merged in as the process "Backend (node)" |
| `data/<id>.js`, `data/index.js` | the analysis of each trace that the pages draw from |
| `lab/` | everything needed to re-run a case: the lab pages, the backend, the harness |

## Open a trace

- **Perfetto** — every step links "open in Perfetto", which loads the file
  straight from this repository; or drag a downloaded `.json.gz` onto
  <https://ui.perfetto.dev>.
- **Chrome DevTools** — Performance panel → Load profile → the `.json.gz`.
  Turn off Settings → Ignore list to see library frames by name.
- **Terminal** — `node lab/harness/q.mjs <id> summary`; then `frames`,
  `tree <from> <to>`, `prof <from> <to>`, `tasks`, `slices <regex>`, `marks`.
  Times are on the same axis as the charts in the pages.

## Run the lab

```sh
cd lab
npm ci
npm run build                 # lab pages → lab/dist (not minified, source maps)
npm run serve                 # http://127.0.0.1:5199/grid.html?lib=regular&cols=100…
node server/main.mjs --psp    # … also hosts the Perspective table for psp.html?engine=remote
sh upstream/fetch.sh          # optional: the libraries' own examples at pinned versions → /upstream/…
```

`grid.html` is one virtualized table configured entirely from the URL; every
knob is documented in `lab/pages/src/config.ts` (library, rows and columns,
data source and request policy, per-cell cost, pool policy, live-update rate
and apply policy, bad network, …). Each trace link in the course shows the
query string of its scenario.

Record and analyze:

```sh
node harness/record.mjs --list            # every scenario and the question it asks
node harness/record.mjs f-budget          # record scenarios whose id starts with f-budget
node harness/analyze.mjs                  # rebuild data/index.js
node harness/check-page.mjs frames.html   # check a course page against the data
```

`BROWSER_PATH` selects the Chrome binary (default
`/usr/bin/google-chrome-stable`). Scenarios are entries in
`lab/harness/scenarios.mjs`: a page query, a viewport, optional CPU throttling
and network shaping, and a list of input actions played through the DevTools
protocol's Input domain. `lab/AUTHORING.md` describes the page format.

## What the lab is made of

- **Three table panels over one data source** (`lab/pages/src`): TanStack
  virtual-core with a keyed or a positional row pool, regular-table, and
  `@tanstack/react-virtual` with React 19. regular-table is served from its
  TypeScript source so traces show its real function names.
- **A backend in Node** (`lab/server`): a request/response row service with a
  service time, jitter and a concurrency limit; a tick stream with conflation,
  a binary wire format and a drop-when-backed-up policy; a Perspective server.
  Every receive, service interval and send is recorded on `CLOCK_MONOTONIC`,
  the clock Chrome's trace uses, and appended to the trace.
- **A bad network in user space** (`lab/server/netem.mjs`): a TCP proxy adding
  delay, jitter, a bandwidth limit and stalls, preserving order and pushing
  back on the sender.
- **A harness** (`lab/harness`): scenario runner, trace analysis (frame
  outcomes per vsync from the compositor's `PipelineReporter`, main-thread
  time by category, forced layouts, sampled JavaScript by function, data age
  from server send to presented frame, queue lengths), and a trace query tool.

## Conditions and limits

- Recorded 2026-11-16 on Linux with headless Chrome 154.0.8037.57: the real
  browser in headless mode, which rasters and composites in software against
  a synthetic 60 Hz vsync. A display with GPU raster will differ in raster and
  presentation times.
- Device scale factor 1.75; one traced run per scenario unless a module says
  otherwise. Tracing itself costs time (Module 2 measures how much). The
  recordings explain mechanisms and compare a control with a treatment made
  the same way; they are not a benchmark of the libraries.
- The backend runs on the same machine; the network is loopback, shaped only
  by the user-space proxy, which models delay and throughput but not loss or
  congestion-window dynamics.
- Numbers shown in bold in the pages are read from `data/`, so they follow a
  re-recording; chart windows and pin positions describe this recording.

## Sources

Chromium `73c14f6228d7` (M154), V8 `671f7c27ac04`, DevTools frontend
`66df492aaa01`; `@tanstack/virtual-core` 3.19.11 and `@tanstack/react-virtual`
3.14.26 (`11b48e4`); regular-table 0.9.2 (`52e86bf`); Perspective 5.9.2
(`0264ec1`); React 19.2.7. Module 1 and its lab come from Tablelab's
`samples/scroll-trace` study (2026-11-15).
