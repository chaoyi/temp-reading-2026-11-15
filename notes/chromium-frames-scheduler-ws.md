# Chromium M154: frame outcomes, schedulers, WebSocket, workers and GC in a trace

Pinned revisions (all read at exactly these commits):

- Chromium `73c14f6228d7cd537c855007e8f88678969cc0eb` (M154). `cc/`, `components/viz/` read from the
  sparse checkout `~/src/repos/chromium`; `base/`, `mojo/`, `net/`, `services/`, the rest of
  `third_party/blink/` fetched from `raw.githubusercontent.com/chromium/chromium/<pin>/<path>`.
- V8 `671f7c27ac0403ceb8074a8dfbcc02cdd7369c3f` (`DEPS:348` `'v8_revision'`). Paths written `v8/src/...`.
- DevTools frontend `66df492aaa0129d090937e933dd44c5389ab24d2` (`DEPS:424` `'devtools_frontend_revision'`).
  Paths written `devtools/front_end/...`.

Tags: **[src]** read at the pin (`path:line` + the decisive line), **[doc]** stated by a source comment,
**[inf]** my inference (I say from what), **[obs]** observed in an existing local trace recorded with
Chrome 154.0.8037.57 (`/workspace/code/tablelab/samples/scroll-trace/results/*.json`; same milestone,
not proven to be the same commit). [obs] is used only for the *JSON shape* of events, which the C++
source cannot show because typed (protobuf) arguments are converted by the JSON exporter.

Thread names: `CrRendererMain` (renderer main), `Compositor` (renderer compositor = "impl" thread),
`VizCompositorThread` (GPU process), `ThreadPoolForegroundWorker`, `DedicatedWorker thread`.

One reading rule up front. Many cc/viz events now carry **typed** arguments. In trace JSON they show up
as a nested object named after the proto field, e.g. `args.frame_reporter.state`,
`args.sequence_manager_task.queue_name`, `args.chrome_graphics_pipeline.step` **[obs]**. Enum values
are the proto enum names as strings (`"STATE_PRESENTED_ALL"`).

---

## 1. Frame outcomes

### 1a. `PipelineReporter` — the compositor's own verdict per BeginFrame

1. `cc/metrics/compositor_frame_reporter.cc:1623-1624,1634-1635` **[src]** —
   `"cc,benchmark," TRACE_DISABLED_BY_DEFAULT("devtools.timeline.frame");` … `kTraceCategory, "PipelineReporter", trace_track, args_.frame_time,` —
   Name `PipelineReporter`, category string `cc,benchmark,disabled-by-default-devtools.timeline.frame`.
   The slice **starts at the BeginFrame's `frame_time`** (vsync), not when the code ran, and ends at
   `frame_termination_time_` (line 1823) — presentation time for a presented frame.
2. `cc/metrics/compositor_frame_reporter.cc:1631-1633` **[src]** — `perfetto::NamedTrack("PipelineReporter", base::trace_event::GetNextGlobalTraceId());` —
   Each reporter gets its own async track. In JSON: `ph:"b"`/`"e"` pairs joined by `id2.local`, emitted
   with the renderer pid and the `Compositor` tid **[obs]**. Stage sub-slices are `b`/`e` events with the
   **same `id2.local`** as their parent. All events are written retroactively when the reporter
   terminates (line 1176 `ReportCompositorLatencyTraceEvents(frame_info);`), so file order ≠ time order.
3. Args (JSON key `args.frame_reporter`; older Chrome used `chrome_frame_reporter`):
   `cc/metrics/compositor_frame_reporter.cc:1656-1716` **[src]** `->set_frame_reporter();` then
   `set_state`, `set_frame_source`, `set_frame_sequence`, `set_layer_tree_host_id`,
   `set_has_missing_content`, `set_checkerboarded_needs_raster`, `set_checkerboarded_needs_record`,
   `set_affects_smoothness`, `set_scroll_state`, `set_has_main_animation`,
   `set_has_compositor_animation`, `set_has_smooth_input_main`, `set_has_high_latency`,
   `set_frame_type`, `set_surface_frame_trace_id`, `set_display_trace_id`.
   Proto: `base/tracing/protos/chrome_track_event.proto:2789-2900` (`message ChromeFrameReporter2`),
   field `frame_reporter = 1075` (line 3311). DevTools accepts both keys:
   `devtools/front_end/models/trace/types/TraceEvents.ts:1738-1744` **[src]**. Shape **[obs]**:
   `"args":{"frame_reporter":{"state":"STATE_PRESENTED_ALL","frame_sequence":3,"frame_source":…,"scroll_state":"SCROLL_COMPOSITOR_THREAD","has_missing_content":true,…}}`.
   - `frame_sequence` = `viz::BeginFrameArgs.frame_id.sequence_number` (line 1661). It equals
     `frameSeqId` on `BeginFrame`/`DrawFrame`/`DroppedFrame`/`Commit` and
     `args.args.sequence_number` on `Scheduler::BeginImplFrame`. This is the join key for a vsync.
   - `state` ∈ `STATE_NO_UPDATE_DESIRED | STATE_PRESENTED_ALL | STATE_PRESENTED_PARTIAL | STATE_DROPPED`
     (proto 2790-2806; mapping at reporter 1639-1654: all three `kPresentedPartial*` → `STATE_PRESENTED_PARTIAL`).
   - `scroll_state` ∈ `SCROLL_NONE | SCROLL_MAIN_THREAD | SCROLL_COMPOSITOR_THREAD | SCROLL_RASTER`
     (1675-1688). `SCROLL_NONE` is what `kUnknown` maps to.
   - `frame_type` is **absent** for an ordinary reporter; `FORKED` or `BACKFILL` otherwise (1705-1709).
   - `has_high_latency` = termination − frame_time > 75 ms (`kHighLatencyMin`, line 122; 1702-1703).
   - `has_missing_content` = `checkerboarded_needs_raster || checkerboarded_needs_record` (1663-1664).
   - `reason` (`FrameDropReason`) exists in the proto (2810-2830) but the pinned emitter never sets it
     **[src: no `set_reason` in the emit block 1656-1716]**. Do not expect it.
4. How `state` is decided — `cc/metrics/compositor_frame_reporter.cc:2046-2112` **[src]**:
   - Presented, no partial flag → `final_state = FrameFinalState::kPresentedAll;` (2073).
   - Presented with `has_partial_update_` → `kPresentedPartialNewMain`/`OldMain` (2058-2060) →
     `STATE_PRESENTED_PARTIAL`.
   - `kDidNotPresentFrame` or `kReplacedByNewReporter` → `kDropped` (2088-2090).
   - `kDidNotProduceFrame` → dropped **unless** the skip reason says nothing was wanted: `kNoDamage`,
     or `kWaitingOnMain` with no partial update (2096-2112); `kDrawThrottled` is always dropped (2109-2110).
   **[doc]** `cc/metrics/frame_info.h:22-27`: "`presented all` … doesn't necessarily mean the frame
   included updates from both the main and the compositor thread"; `:30-33`: "A `partial update` frame
   contains updates from a compositor frame, but misses the update from the main-thread for the same vsync."
5. Forking — why one vsync can have **two** `PipelineReporter`s. When the compositor submits while the
   main thread still owes a BeginMainFrame for that id, the controller clones the reporter:
   `cc/metrics/compositor_frame_reporting_controller.cc:372-384` **[src]** `auto reporter = RestoreReporterAtBeginImpl(current_frame_id);`;
   `compositor_frame_reporter.cc:912,918` `new_reporter->set_is_forked(true);` …
   `new_reporter->SetPartialUpdateDecider(this);` (which sets `has_partial_update_ = true`, line 2012).
   The fork is the **compositor-only** frame (`frame_type:"FORKED"`); the original keeps running through
   `SendBeginMainFrameToCommit` … and terminates when the main-thread content is presented.
   If the original later ends "no update desired" (main aborted with no changes), the fork's partial flag
   is cleared (`compositor_frame_reporter.cc:1152-1163`, line 1161 `dependent->set_has_partial_update(false);`) and
   the fork reports `STATE_PRESENTED_ALL`. So a fork is partial only if the main thread really had
   something. **[obs]** forks seen as `STATE_PRESENTED_PARTIAL`, `STATE_PRESENTED_ALL`,
   `STATE_NO_UPDATE_DESIRED`, `STATE_DROPPED`.
   A non-forked reporter can also be partial: a newer frame submitted while an **older** frame's main
   update is still outstanding — `…reporting_controller.cc:357-360` **[src]**
   `GetOutstandingUpdatesFromMain(current_frame_id);` / `impl_reporter->SetPartialUpdateDecider(partial_update_decider);`.
6. Backfill — vsyncs the compositor never started. On the next BeginImplFrame the gap in sequence
   numbers is filled with synthetic reporters: `…reporting_controller.cc:886-963` **[src]**
   `reporter->TerminateFrame(FrameTerminationStatus::kDidNotPresentFrame, args.deadline);`
   `reporter->set_is_backfill(true);` → `state:"STATE_DROPPED"`, `frame_type:"BACKFILL"`; at most 100
   (`kMaxFrameCount`, 898). A synthetic `BeginFrame` instant is emitted for each (941).
7. `affects_smoothness` — `cc/metrics/frame_info.cc:48-55` **[src]**
   `if (smooth_thread == SmoothThread::kSmoothNone) return false;` /
   `return WasSmoothMainUpdateDropped() || WasSmoothCompositorUpdateDropped();` —
   true only when a scroll/animation ("smooth" sequence) was active on the thread whose update was lost.
   A dropped frame with nothing animating has `affects_smoothness:false` and DevTools does not show it
   as dropped (see 1c).
8. Stage sub-slices — names from `compositor_frame_reporter.cc:685-724` **[src]**:
   `BeginImplFrameToSendBeginMainFrame`, `SendBeginMainFrameToCommit`, `Commit`,
   `EndCommitToActivation`, `Activation`, `EndActivateToSubmitCompositorFrame`,
   `SubmitCompositorFrameToPresentationCompositorFrame`. Where each starts
   (`…reporting_controller.cc` **[src]**): `WillBeginImplFrame` 177; `WillBeginMainFrame` 193;
   `WillCommit` 243 (`StageType::kCommit`); `DidCommit` 249; `WillActivate` 264; `DidActivate` 273;
   `DidSubmitCompositorFrame` 351/440/461.
   - Zero-length stages are skipped: `compositor_frame_reporter.cc:1723-1724` `if (stage.start_time == stage.end_time) continue;`.
   - A compositor-only (forked or impl-only) reporter has **no** `SendBeginMainFrameToCommit`/`Commit`/
     `EndCommitToActivation`/`Activation`: it goes `BeginImplFrameToSendBeginMainFrame` →
     `EndActivateToSubmitCompositorFrame` → `Submit…` (`…reporting_controller.cc:347-356`). **[inf from that code + obs]**
     Presence of a `Commit` child under the same `id2.local` is therefore the test for "this presented
     frame carried a main-thread commit made for this vsync".
   - Caution **[obs]**: other events are also named `Commit` (the main-thread
     `disabled-by-default-devtools.timeline` one, and an `EventLatency` stage in
     `cc,benchmark,input,input.scrolling`). Filter by `cat` as well as name.
   - `SendBeginMainFrameToCommit` carries a Blink breakdown, JSON key
     `args.send_begin_mainframe_to_commit_breakdown` with `handle_input_events_us`, `animate_us`,
     `style_update_us`, `layout_update_us`, `accessibility_update_us`, `prepaint_us`,
     `compositing_inputs_us`, `paint_us`, `composite_commit_us`, `update_layers_us`,
     `begin_main_sent_to_started_us` (`compositor_frame_reporter.cc:1728-1777` **[src]**).
     `begin_main_sent_to_started_us` is the time the BeginMainFrame task waited in the main thread's
     queue — the single most direct "main thread was busy" number. **[obs]** it can hold a wrapped
     negative (`18446743838491993918`) when the stage never started; treat values > 2^63 as invalid.
   - Viz breakdown children of `SubmitCompositorFrameToPresentationCompositorFrame`
     (`compositor_frame_reporter.cc:866-884,1784-1798` **[src]**): `SubmitToReceiveCompositorFrame`,
     `ReceiveCompositorFrameToStartDraw`, `StartDrawToSwapStart`, `Swap`,
     `SwapEndToPresentationCompositorFrame`, and on platforms with detailed swap timing
     `SwapStartToBufferAvailable`, `BufferAvailableToBufferReady`, `BufferReadyToLatch`, `LatchToSwapEnd`.
     (The dotted long forms at 725-758 are histogram names, not trace names.) **[obs]** Linux trace shows
     the first three plus `SwapEndToPresentationCompositorFrame`.
9. Recipe for (a)/(b)/(c), per `frame_sequence` **[inf from items 3-8]**:
   - (a) presented with this vsync's main commit: exactly one reporter for N, `state:"STATE_PRESENTED_ALL"`,
     with a `Commit` stage child, and **no `FORKED` sibling** for N.
   - (b) presented without the main thread's update: a reporter with `state:"STATE_PRESENTED_PARTIAL"`
     (usually `frame_type:"FORKED"`). Its sibling original for the same `frame_sequence` is the late
     main frame: it has the `Commit` child, usually ends `STATE_PRESENTED_ALL`, and its end timestamp is
     when the main-thread content finally reached the screen (one or more vsyncs later; long
     `SendBeginMainFrameToCommit`, often `has_high_latency:true`). So "`STATE_PRESENTED_ALL` + `Commit`
     child" alone does not mean on time — check for a fork.
   - (c) dropped: `state:"STATE_DROPPED"`; `frame_type:"BACKFILL"` means the compositor never even
     began that vsync. Use `affects_smoothness` to separate user-visible drops from idle ones.
   - `STATE_NO_UPDATE_DESIRED`: nothing wanted a frame; not a drop.
   - `STATE_PRESENTED_ALL` **without** a `Commit` child = compositor-only frame while the main thread
     owed nothing (pure compositor scroll/animation).

### 1b. `disabled-by-default-devtools.timeline.frame` instants

All defined in `cc/base/devtools_instrumentation.h` (names 43-50, arg keys 33-39: `data`, `frameId`,
`layerId`, `layerTreeId`, `frameSeqId`, `hasPartialUpdate`). All are skipped for UI compositors
(`if (!GetSettings().is_layer_tree_for_ui)`).

| Event | Args | Emit site **[src]** | Thread |
|---|---|---|---|
| `BeginFrame` | `layerTreeId`, `frameSeqId`; ts = `frame_time` | `devtools_instrumentation.h:175-183`; called `cc/trees/layer_tree_host_impl.cc:3655` (`WillBeginImplFrame`) and for backfilled vsyncs `cc/metrics/compositor_frame_reporting_controller.cc:941` | Compositor |
| `RequestMainThreadFrame` | `layerTreeId` | `cc/trees/proxy_impl.cc:847` right after posting `ProxyMain::BeginMainFrame` (845) | Compositor |
| `BeginMainThreadFrame` | `layerTreeId`, `data.frameId` (source frame number) | `cc/trees/layer_tree_host.cc:371` (`LayerTreeHost::WillBeginMainFrame`) | CrRendererMain |
| `Commit` (cat `disabled-by-default-devtools.timeline`, a duration event) | `layerTreeId`, `frameSeqId` | `devtools_instrumentation.h:132-141`; `cc/trees/proxy_main.cc:434` | CrRendererMain |
| `ActivateLayerTree` | `layerTreeId`, `frameId` | `cc/trees/layer_tree_impl.cc:2090` | Compositor |
| `DrawFrame` | `layerTreeId`, `frameSeqId` | `cc/trees/layer_tree_host_impl.cc:3028` (inside `DrawLayers`, after a successful draw) | Compositor |
| `DroppedFrame` | `layerTreeId`, `frameSeqId`, `hasPartialUpdate`; ts = `frame_time` | `devtools_instrumentation.h:199-210`; called `cc/metrics/compositor_frame_reporter.cc:1617-1620` | Compositor |
| `NeedsBeginFrameChanged` | `layerTreeId`, `data.needsBeginFrame` (0/1) | `cc/scheduler/scheduler.cc:386,398` | Compositor |

Key facts:

10. `cc/metrics/compositor_frame_reporter.cc:1617-1620` **[src]** — `if (info.IsDroppedAffectingSmoothness()) { devtools_instrumentation::DidDropSmoothnessFrame(… has_partial_update_); }` —
    `DroppedFrame` is emitted **only** for frames that affect smoothness, and it is emitted for
    *partial* frames too, with `hasPartialUpdate:true`. So `DroppedFrame` ≠ "no pixels changed".
11. **[doc]** `cc/trees/proxy_main.cc:427-433`: "The devtools "Commit" step includes the update layers
    pipeline stage through to the main thread handoff to the compositor thread"; it "omits time that
    the main thread is blocked on commit *after* BeginMainFrame has finished".
12. JSON shapes **[obs]**: `{"name":"BeginFrame","ph":"I","args":{"frameSeqId":37,"layerTreeId":2}}`,
    `{"name":"BeginMainThreadFrame","args":{"data":{"frameId":5},"layerTreeId":2}}`,
    `{"name":"NeedsBeginFrameChanged","args":{"data":{"needsBeginFrame":0},"layerTreeId":2}}`.

### 1c. How DevTools builds the Frames track

13. `devtools/front_end/models/trace/handlers/FramesHandler.ts:29-44` **[src]** — the model consumes only
    `SetLayerTreeId`, `BeginFrame`, `DroppedFrame`, `RequestMainThreadFrame`, `BeginMainThreadFrame`,
    `NeedsBeginFrameChanged`, `Commit`/`CompositeLayers`, `ActivateLayerTree`, `DrawFrame` (plus main-thread
    `RunTask`, `Paint`, and markers at 51-56). **It does not read `PipelineReporter`.**
14. `FramesHandler.ts:329-331` **[src]** — `if (entry.args['layerTreeId'] !== this.#layerTreeId) { return; }` — only the main frame's layer tree counts.
15. `FramesHandler.ts:179-181,192` **[src]** — `// - only show frames that either did not wait for the main thread frame or had one committed.` `if (this.#mainFrameCommitted || !this.#mainFrameRequested) {` … `processPendingBeginFramesOnDrawFrame(seqId)` —
    A frame boundary is created at a `DrawFrame` whose `frameSeqId` has a queued `BeginFrame`, and only
    if no main frame is outstanding or one has committed. A `DrawFrame` during an outstanding
    `RequestMainThreadFrame` (compositor drew without the main thread) creates **no new frame**; it is
    absorbed into the current one.
16. `FramesHandler.ts:160-171,346` **[src]** — `this.#beginFrameQueue.setDropped(seqId, true);` `this.#beginFrameQueue.setPartial(seqId, isPartial);` with `Boolean(entry.args['hasPartialUpdate'])` — dropped/partial flags come solely from `DroppedFrame`.
17. `FramesHandler.ts:544-553` **[src]** — `if (currentFrame && currentFrame.isDropped) { framesToVisualize.push(currentFrame); }` — earlier `BeginFrame`s that were never drawn are shown only if flagged dropped; the others "will be naturally presented as continuations of other frames" (**[doc]** 540-543).
18. `devtools/front_end/panels/timeline/TimelineFlameChartDataProvider.ts:863-866` **[src]** —
    `if (frame.idle) {…idleFrame} else if (frame.dropped) { title = frame.isPartial ? …partiallyPresentedFrame : …droppedFrame; }` —
    UI labels: "Idle frame", "Partially-presented frame", "Dropped frame", else "Frame".
    Idle: `FramesHandler.ts:182-189` (a `NeedsBeginFrameChanged(1)` followed by a gap).
19. Consequence **[inf from 10, 15-18]**: DevTools' "dropped"/"partially presented" = cc's
    smoothness-affecting drops only. For per-vsync truth use `PipelineReporter`; use the DevTools track
    as the user-facing view.

### 1d. Viz side: `Graphics.Pipeline` and `Display::DrawAndSwap`

20. `Graphics.Pipeline` (cat `viz,benchmark,graphics.pipeline`; a few sites use `graphics.pipeline`
    alone) is one event name with a typed `step`, JSON `args.chrome_graphics_pipeline.step` **[obs]**.
    Steps and sites **[src]**, in order for a renderer frame:
    `STEP_ISSUE_BEGIN_FRAME` (`components/viz/service/frame_sinks/compositor_frame_sink_support.cc:1187`, viz) →
    `STEP_SEND_ON_BEGIN_FRAME_MOJO_MESSAGE` (same file 1236) →
    `STEP_RECEIVE_BEGIN_FRAME` / `STEP_RECEIVE_BEGIN_FRAME_DISCARD` (`cc/mojo_embedder/async_layer_tree_frame_sink.cc:336`, renderer; `_DISCARD` when `!needs_begin_frames_`) →
    `STEP_GENERATE_COMPOSITOR_FRAME` (`cc/trees/proxy_impl.cc:992-999`) →
    `STEP_SUBMIT_COMPOSITOR_FRAME` (`cc/trees/layer_tree_host_impl.cc:2924-2931`) →
    `STEP_SEND_SUBMIT_COMPOSITOR_FRAME_MOJO_MESSAGE` (`cc/mojo_embedder/async_layer_tree_frame_sink.cc:256`) →
    `STEP_RECEIVE_COMPOSITOR_FRAME` (`compositor_frame_sink_support.cc:774`) →
    `STEP_SURFACE_AGGREGATION` (`components/viz/service/display/surface_aggregator.cc:2176`) →
    `STEP_DRAW_AND_SWAP` (`components/viz/service/display/display.cc:782-791`) →
    `STEP_SEND_BUFFER_SWAP` (`display.cc:1080-1090`) → `STEP_BUFFER_SWAP_POST_SUBMIT` (`components/viz/service/display_embedder/skia_output_surface_impl_on_gpu.cc:2374-2382`, GPU main thread) → `STEP_FINISH_BUFFER_SWAP` (`components/viz/service/display_embedder/skia_output_device.cc:211-218`) →
    `STEP_SWAP_BUFFERS_ACK` (`display.cc:1161-1170`).
    Not-produced path: `STEP_DID_NOT_PRODUCE_COMPOSITOR_FRAME` with `frame_skipped_reason`
    (`async_layer_tree_frame_sink.cc:278`, renderer) and `STEP_DID_NOT_PRODUCE_FRAME`
    (`compositor_frame_sink_support.cc:700-708`, viz).
    Steps up to aggregation are linked by `surface_frame_trace_id` (= `BeginFrameArgs.trace_id`, also on
    `PipelineReporter`); steps from `STEP_DRAW_AND_SWAP` by `display_trace_id`. In JSON the links are
    flow events `ph:"s"/"t"/"f"` named `Graphics.Pipeline` **[obs]**.
21. `components/viz/service/display/display.cc:755` **[src]** — `TRACE_EVENT0("viz", "Display::DrawAndSwap");` — the synchronous viz work for one display frame. Early-outs are instants in `viz`: `"No root surface."` 771, `"No output surface"` 776, `"Empty aggregated frame."` 876, `"Skip draw"` 888, `"Size mismatch."` 934, `"Draw skipped."` 971, `"Swap skipped."` 1110.
22. `display.cc:880-882,1358-1361` **[src]** — `"viz,benchmark", "Graphics.Pipeline.DrawAndSwap", perfetto::NamedTrack("Graphics.Pipeline", display_trace_id)` … ended in `DidReceivePresentationFeedback` at `copy_feedback.timestamp` — an **async** slice from viz draw start to **presentation**. Children on the same track: `Graphics.Pipeline.Draw` (942-968), instants `Graphics.Pipeline.WaitForSwap` (1066), `Swap` (1181, ts = `swap_start`), `WaitForPresentation` (1185, ts = `swap_end`). A cancelled swap ends it with `"status":"canceled"` (1134-1137).
23. `display.cc:1362-1364` **[src]** — `"benchmark,viz," TRACE_DISABLED_BY_DEFAULT("display.framedisplayed"), "Display::FrameDisplayed", copy_feedback.timestamp` — instant at the presentation timestamp.
24. Display scheduler reasons (cat `viz`, `components/viz/service/display/display_scheduler.cc` **[src]**): `DisplayScheduler::BeginFrame` 415, `DisplayScheduler::OnBeginFrameDeadline` 835, `DisplayScheduler::DrawAndSwap` 332, instants `"Swap throttled"` 726 (`pending_swaps`, `max_pending_swaps`), `"All active surfaces ready"` 753, `"No damage yet"` 758, `"More damage expected soon"` 768.

---

## 2. Compositor scheduler and a late main thread

### 2a. The deadline: when cc waits for the commit and when it draws without it

25. `cc/scheduler/scheduler_state_machine.cc:442` **[src]** — `if (begin_impl_frame_state_ != BeginImplFrameState::INSIDE_DEADLINE) return false;` (in `ShouldDraw`) — the compositor draws only once the per-frame *deadline* fires. The whole "wait or not" question is: when does the deadline fire.
26. `scheduler_state_machine.cc:1336-1365` **[src]** — `CurrentBeginImplFrameDeadlineMode()`:
    - `NONE` — outside a begin frame (or synchronous compositor).
    - `BLOCKED` — full-pipeline mode only; unreachable in a threaded renderer because
      `ShouldBlockDeadlineIndefinitely()` returns false when `!settings_.commit_to_active_tree`
      (1435-1442), and `third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc:207`
      sets `settings.commit_to_active_tree = !is_threaded;`.
    - `WAIT_FOR_SCROLL` — would be immediate, but scrolling and no scroll event has arrived yet for this frame.
    - `IMMEDIATE` — "ready to draw a new active tree immediately because there's no commit expected or we're prioritizing active tree latency" **[doc 1353-1354]**.
    - `REGULAR` — `needs_redraw_`: "an animation or fast input path on the impl thread … wants to draw, so don't wait too long for a new active tree" **[doc 1357-1358]**.
    - `LATE` — "The impl thread doesn't have anything it wants to draw and we are just waiting for a new active tree" **[doc 1361-1362]**.
27. Deadline times — `cc/scheduler/scheduler.cc:831-859` **[src]**: `LATE` → `frame_time + interval` (next vsync); `REGULAR` → `Current().deadline` (847), where the args' deadline was shortened by `DrawDurationEstimate()` and `kDeadlineFudgeFactor` = 1000 µs (47, 607-608); `IMMEDIATE` → `base::TimeTicks()` (now); `WAIT_FOR_SCROLL` → `frame_time + interval * scroll_deadline_ratio` (`scheduler_settings.h:60` default `0.333`).
28. What makes it `IMMEDIATE` — `scheduler_state_machine.cc:1384-1433` **[src]** (`ShouldTriggerBeginImplFrameDeadlineImmediately`): a freshly activated tree `if (active_tree_needs_first_draw_) return true;` (1400); nothing to redraw → false (1407); `bool wait_for_main = CommitPending() || has_pending_tree_;` (1412) and if no BeginMainFrame was sent this frame and main is not busy → true with instant `TriggerDeadlineDueToThrottling` (1413-1416); `if (!wait_for_main) return true;` (1424); `if (ImplLatencyTakesPriority()) return true;` (1429).
29. `scheduler_state_machine.cc:1615-1625` **[src]** — `if (SMOOTHNESS_TAKES_PRIORITY == tree_priority_) return true;` — `ImplLatencyTakesPriority` is exactly "tree priority is smoothness".
    Set in `cc/trees/proxy_impl.cc:613-627` **[src]**: `if ((non_scroll_interaction_in_progress || precise_scrolling_in_progress) && !avoid_entering_smoothness) { smoothness_priority_expiration_notifier_.Schedule(); }` … `tree_priority = SMOOTHNESS_TAKES_PRIORITY;` with `kSmoothnessTakesPriorityExpirationDelay = base::Milliseconds(250)` (61-62).
    Overridden to `NEW_CONTENT_TAKES_PRIORITY` when `is_current_scroll_main_painted` (the scroll needs main-thread repaint) (634-640).
30. Summary **[inf from 25-29]**. With a BeginMainFrame outstanding (`CommitPending()`):
    - compositor has its own damage and is in a precise compositor scroll/pinch (≤250 ms ago) → `IMMEDIATE`: draws at once without the commit → partial frame.
    - compositor has its own damage, no smoothness priority → `REGULAR`: waits until the (shortened) vsync deadline, then draws whatever is active. Commit arrived and activated in time → full frame; otherwise partial frame, and `main_thread_missed_last_deadline` becomes true.
    - compositor has nothing to draw → `LATE`: waits to the next vsync; if no activation, no frame is submitted (`DidNotSubmitInLastFrame`, reason `kWaitingOnMain`) — a dropped main-thread frame if a smooth main-thread effect was running.
    **[obs]** all of `LATE`, `REGULAR`, `IMMEDIATE`, `WAIT_FOR_SCROLL` occur in the M154 sample traces.

### 2b. What stops `BeginMainFrame` from being sent

31. `scheduler_state_machine.cc:515-637` **[src]** — `CouldSendBeginMainFrame` + `ShouldSendBeginMainFrame`, in order:
    - `if (!needs_begin_main_frame_) return false;` (516) — nobody asked (no `SetNeedsCommit`/`SetNeedsAnimate`/rAF).
    - not visible (520), begin-frame source paused (525), `defer_begin_main_frame_` (529), `pause_rendering_` (533).
    - `if (did_send_begin_main_frame_for_current_frame_ && !urgent_begin_main_frame_pending_) return false;` (549) — at most one per vsync.
    - `case BeginMainFrameState::SENT: return false;` (561-562) — **the previous BeginMainFrame has not come back yet**. This is the case that matters under a main-thread flood: one in flight, no new one until `NotifyReadyToCommit` or an abort.
    - `READY_TO_COMMIT` and not (`main_frame_before_commit_enabled` with next state idle) (563-568).
    - `if (has_pending_tree_ && !can_send_main_frame_with_pending_tree) return false;` (576) — the last commit has not activated (raster still running) and main-frame-before-activation is off; `layer_tree_settings.cc:211-212` **[src]** `settings.main_frame_before_activation_enabled = cmd.HasSwitch(::switches::kEnableMainFrameBeforeActivation);` → off unless the command-line switch is given.
    - `if (ImplLatencyTakesPriority() && ((has_pending_tree_ && …) || (active_tree_needs_first_draw_ && …))) return false;` (587-592).
    - `if (ShouldBlockBeginMainFrameWhenIdle() && !urgent_begin_main_frame_pending_) return false;` (598) — not between frames.
    - `if (IsDrawThrottled() && !just_submitted_in_deadline) return false;` (620) — a submitted frame has not been acked by viz (`kMaxPendingSubmitFrames = 1`, line 34).
    - `if (ShouldWaitForScrollEvent()) return false;` (626).
    - `if (ShouldThrottleSendBeginMainFrame()) return false;` (632) — emits instant `bool cc::SchedulerStateMachine::ShouldThrottleSendBeginMainFrame() const` (name is `__PRETTY_FUNCTION__`) with `result` (663).
32. In a trace: a sent BeginMainFrame = `RequestMainThreadFrame` instant + `SendBeginMainFrame` instant (`cc/trees/proxy_impl.cc:831-832`, cat `cc,benchmark`) on `Compositor`, then on `CrRendererMain` `ProxyMain::BeginMainFrame` (`cc/trees/proxy_main.cc:216`, `cc,benchmark`, arg `begin_frame_id` = sequence number). The gap between the two is main-thread queueing. A vsync with `Scheduler::BeginImplFrame` but no `RequestMainThreadFrame` while a `ProxyMain::BeginMainFrame` slice is open or pending = skipped because of `SENT`. **[inf from 31]**
33. Aborts (main had nothing): `cc/trees/proxy_main.cc:247,283,392,485` **[src]** `TRACE_EVENT("cc,benchmark", "MainFrameAborted", …)` with typed `aborted_on_main_reason`; JSON **[obs]** `args.main_frame_pipeline:{"step":"ABORTED_ON_MAIN","aborted_on_main_reason":"NO_UPDATE",…}`. Compositor side: `Scheduler::BeginMainFrameAborted` with `reason` (`scheduler.cc:316`), `ProxyImpl::BeginMainFrameAbortedOnImplThread` (`proxy_impl.cc:311`).

### 2c. Events that record a missed deadline

34. `cc/scheduler/scheduler.cc:586-590` **[src]** — `state_machine_->main_thread_missed_last_deadline();` `TRACE_EVENT2("cc,benchmark", "Scheduler::BeginImplFrame", "args", args.AsValue(), "main_thread_missed_last_deadline", main_thread_is_in_high_latency_mode);` —
    one per started vsync on `Compositor`. JSON **[obs]**:
    `"args":{"args":{"sequence_number":37,"source_id":22,"frame_time_us":…,"deadline_us":…,"interval_us":16666,"subtype":"NORMAL","on_critical_path":true,…},"main_thread_missed_last_deadline":false}`
    (keys from `components/viz/common/frame_sinks/begin_frame_args.cc:182-199`).
    The flag describes the **previous** frame.
35. Definition — `scheduler_state_machine.cc:1325-1328` **[src]** (at end of impl frame) `main_thread_missed_last_deadline_ = CommitPending() || has_pending_tree_ || active_tree_needs_first_draw_;` **[doc 1325-1326]** "If a new or undrawn active tree is pending after the deadline, then the main thread is in a high latency mode." Also at draw time: `:1027-1029` `CommitPending() || (has_pending_tree_ && !current_pending_tree_is_impl_side_);`. Reset on abort (1665).
    Note it is also true when the commit arrived but **raster/activation** was late (`has_pending_tree_`), so it means "main-thread content missed the deadline", not strictly "main thread was slow". Use the `PipelineReporter` stages to split main time (`SendBeginMainFrameToCommit`) from raster (`EndCommitToActivation`).
36. `scheduler.cc:864-869` **[src]** — `TRACE_EVENT2("cc", "Scheduler::ScheduleBeginImplFrameDeadline", "new deadline", new_deadline, "deadline mode", …ToString(deadline_mode_));` — JSON **[obs]** `"args":{"deadline mode":"BeginImplFrameDeadlineMode::LATE","new deadline":235218140898}`. Emitted whenever the mode/deadline changes inside a frame, so the *last* one before `Scheduler::OnBeginImplFrameDeadline` (`scheduler.cc:891`, `cc,benchmark`) tells why the compositor stopped waiting.
37. `scheduler.cc:716-731` **[src]** — `TRACE_EVENT2("cc", "DidNotSubmitInLastFrame", "has_pending_tree", has_pending_tree, "is_waiting_on_main", is_waiting_on_main);` then `reason = FrameSkippedReason::kWaitingOnMain;` / `kDrawThrottled` / default `kNoDamage`. A vsync that ended with no submit. `is_waiting_on_main:true` ⇒ BeginMainFrame still out.
38. `cc/trees/layer_tree_host_impl.cc:3739-3755` **[src]** — `"cc,benchmark", "LayerTreeHostImpl::DidNotProduceFrame", "FrameSkippedReason", …, "Frame Sequence Number", ack.frame_id.sequence_number` — values `kRecoverLatency | kNoDamage | kWaitingOnMain | kDrawThrottled` (enum `cc/scheduler/scheduler.h:48-53`).
39. BeginFrames the scheduler discards (instants, cat `cc`, `scheduler.cc` **[src]**): `Scheduler::BeginFrameDropped` (406 going idle; 481 `!BeginFrameNeeded()`; 512 a newer BeginFrame replaced a queued one → `kRecoverLatency`), `Scheduler::MissedBeginFrameDropped` (599: a `MISSED` begin frame whose deadline already passed). These vsyncs later appear as `BACKFILL` reporters or have no reporter.
40. Full state dump (not in the requested category list): `scheduler.cc:993-999` **[src]** `TRACE_EVENT(TRACE_DISABLED_BY_DEFAULT("cc.debug.scheduler"), "SchedulerStateMachine", …set_cc_scheduler_state())` per action, including `minor_state.main_thread_missed_last_deadline` (`scheduler_state_machine.cc:310-311`); and counter `MainThreadLatency` (`scheduler.cc:591-592`). Add `disabled-by-default-cc.debug.scheduler` if the state machine itself is the lesson.
41. "MainFrameBeforeActivation" is a setting, not an event: `cc/scheduler/scheduler_settings.h:29,33` **[src]** `bool main_frame_before_activation_enabled = false;` `bool main_frame_before_commit_enabled = false;`. It shows in a trace only through `Scheduler::Scheduler` `settings` arg (`scheduler.cc:78`) at startup.

### 2d. Checkerboarding during a compositor scroll

42. Two sources feed `has_missing_content` — `cc/trees/layer_tree_host_impl.cc:1630` **[src]** `frame->checkerboarded_needs_raster = !tile_manager_.PrepareToDraw();` and `:1447-1449` `layer->ComputeCheckerboardedNeedsRecord()) { frame->checkerboarded_needs_record = true; }`; passed to the reporter at 3065-3066 and copied at `cc/metrics/compositor_frame_reporting_controller.cc:446-449,468-472`.
    - `needs_raster`: `cc/tiles/tile_manager.cc:752-779,1834-1838` **[src]** — `PrepareToDraw` returns `IsReadyToDraw()` = all `REQUIRED_FOR_DRAW` tiles are rastered. **[inf]** so it means "some visible tile is not ready at draw", which includes low-res-substituted content, not only blank holes.
    - `needs_record`: `cc/layers/picture_layer_impl.cc:307-345` **[src]** — the scrolled-to region lies outside what the main thread has **painted** (the cull rect: `if (!cull_rect->Contains(gfx::ToEnclosedRect(visible_rect))) return true;`). Only a new main-thread paint/commit can fix this. For a virtualized table this is the "scrolled past the rendered rows" case **[inf]**.
43. Exact per-draw count: `cc/trees/layer_tree_host_impl.cc:1217-1220,1574-1575` **[src]** — `TRACE_EVENT_BEGIN("cc,benchmark", "LayerTreeHostImpl::CalculateRenderPasses", "render_surface_list.size()", …, "RequiresHighResToDraw", RequiresHighResToDraw());` … `TRACE_EVENT_END("cc,benchmark", "draw_result", draw_result, "missing tiles", num_missing_tiles);` — the slice's end args `draw_result` and `missing tiles`.
44. `cc/layers/tile_based_layer_impl.h:451-455` **[src]** — `TRACE_EVENT_INSTANT("cc", "TileBasedLayerImpl::AppendQuads checkerboard", "missing_tile_count", missing_tile_count);` — one instant per layer per draw that had missing tiles. **[obs]** present (25×) in the M154 scrollbar-drag sample.
45. `cc/tiles/tile_manager.cc:753,774-776` **[src]** — `TRACE_EVENT0("cc", "TileManager::PrepareToDraw");` and instant `TileManager::PrepareToDrawFinished` with `stats`.
46. A draw can be aborted instead of checkerboarded: `layer_tree_host_impl.cc:1498-1507` **[src]** `if (frame->checkerboarded_needs_raster) { if (RequiresHighResToDraw()) { … draw_result = DrawResult::kAbortedMissingHighResContent; } }` (set when tree priority is `NEW_CONTENT_TAKES_PRIORITY`, `proxy_impl.cc:638`) → no `DrawFrame` for that vsync.
47. Sequence-level summary: `cc/metrics/frame_sequence_metrics.cc:517-556,649-652,467-514` **[src]** — async slice `FrameSequenceTrackerV3` (cat `cc,benchmark`) with begin arg `name` (`WheelScroll`, `TouchScroll`, `ScrollbarScroll`, `RAF`, `MainThreadAnimation`, `CompositorAnimation`, … from `cc/metrics/frame_sequence_tracker.cc:20-49`), child slices `Frame`, and end args `args.data.{expected,dropped_v3,dropped_v4,missing_content,checkerboarded,checkerboarded_need_raster,checkerboarded_need_record}`. One per scroll gesture/animation: quickest way to count checkerboarded frames in a scroll.
48. `cc/trees/proxy_impl.cc:601-606` **[src]** — `avoid_entering_smoothness = (base::FeatureList::IsEnabled(features::kNewContentForCheckerboardedScrolls) && host_impl_->PrioritizeNewContentDueToCheckerboarding()) || …` — a feature can stop smoothness priority while checkerboarding (default state not read).

---

## 3. Blink main-thread task priorities

### 3a. Queues, task types, priorities

Priority order, highest first — `third_party/blink/renderer/platform/scheduler/common/task_priority.h:15-28` **[src]**:
`kControlPriority, kHighestPriority, kExtremelyHighPriority, kVeryHighPriority, kHighPriorityContinuation, kHighPriority, kNormalPriorityContinuation, kNormalPriority, kLowPriorityContinuation, kLowPriority, kBestEffortPriority`.

Per-frame queue traits: `…/scheduler/main_thread/frame_scheduler_impl.cc:487-680` (`CreateQueueTraitsForTaskType`); per-frame priority: `:1136-1234` (`ComputePriority`, falls through to `return TaskPriority::kNormalPriority;` at 1233); global queues: `…/main_thread_scheduler_impl.cc:2664-2695`.

| Work | Task type / queue (trace `queue_name`) | Priority | Citation **[src]** |
|---|---|---|---|
| (i) Input events from compositor to main | per-widget input queue, `kMainThreadTaskQueueInput`, `INPUT_TQ` | `kHighestPriority` always | `widget_scheduler_impl.cc:29-36` `QueueType::kInput … PrioritisationType::kInput`; `main_thread_scheduler_impl.cc:2685-2686` `case …::kInput: return TaskPriority::kHighestPriority;`; runner wired at `platform/widget/input/widget_input_handler_manager.cc:298,310` `widget_scheduler_->InputTaskRunner()` |
| (ii) BeginMainFrame | per-agent-group compositor queue, `kMainThreadTaskQueueCompositor`, `COMPOSITOR_TQ` | **dynamic** `compositor_priority` (3b) | `agent_group_scheduler_impl.cc:34-41,50-53`; `platform/widget/widget_base.cc:212-213` `main_thread_compositor_task_runner_ = page_scheduler.GetAgentGroupScheduler().CompositorTaskRunner();`; `main_thread_scheduler_impl.cc:2683-2684` `case …::kCompositor: return main_thread_only().compositor_priority;` |
| (iii) WebSocket frame delivery (`onmessage`) | **`TaskType::kNetworking`** → loading queue, `FRAME_LOADING_TQ` | `kNormalPriority` | `modules/websockets/websocket_channel_impl.cc:592-594` `client_receiver_.Bind(…, execution_context_->GetTaskRunner(TaskType::kNetworking));` and `:274-277` (readable watcher); `frame_scheduler_impl.cc:508-510` `case TaskType::kNetworking: return LoadingTaskQueueTraits();` |
| (iii′) WebSocket bookkeeping (`bufferedAmount` update, unpause, connect/handshake) | `TaskType::kWebSocket` → deferrable queue, `FRAME_DEFERRABLE_TQ` | `kNormalPriority` | `dom_websocket.cc:118,302`; `websocket_channel_impl.cc:369,379`; `frame_scheduler_impl.cc:539,558` `case TaskType::kWebSocket:` … `return DeferrableTaskQueueTraits();` |
| (iv) `postMessage` from a worker | `TaskType::kPostedMessage` → pausable queue, `FRAME_PAUSABLE_TQ` | `kNormalPriority` | `core/workers/dedicated_worker_object_proxy.cc:66-67`; `frame_scheduler_impl.cc:567,581` |
| (v) Timers | `kJavascriptTimerImmediate` (0 ms, low nesting) → deferrable; `kJavascriptTimerDelayedLowNesting` → throttleable (`FRAME_THROTTLEABLE_TQ`); `kJavascriptTimerDelayedHighNesting` → throttleable (+intensive) | `kNormalPriority` | `core/scheduler/dom_timer.cc:332-338`; `frame_scheduler_impl.cc:494-507` |
| (vi) rAF callbacks | not a queue of their own: run **inside** the BeginMainFrame task | that of `COMPOSITOR_TQ` | `core/frame/web_frame_widget_impl.cc:3044` `"WebFrameWidgetImpl::BeginMainFrame"` → `core/page/page_animator.cc:102` `"PageAnimator::serviceScriptedAnimations"` → `core/dom/frame_request_callback_collection.cc:114` `DEVTOOLS_TIMELINE_TRACE_EVENT("FireAnimationFrame", …)` |
| Mojo IPC on the default runner | `kMainThreadTaskQueueDefault`, `DEFAULT_TQ` | normal; `kVeryHighPriority` while an urgent IPC is pending | `main_thread_scheduler_impl.cc:2676-2680` |

`TaskType` definitions: `third_party/blink/public/platform/task_type.h:50` `kNetworking = 3`, `:106` `kWebSocket = 12`, `:110` `kPostedMessage = 13`.

Queue/priority/task-type as seen in JSON **[obs]** (the "WebSocket message" row is the surprising one):
`"sequence_manager_task":{"priority":"NORMAL_PRIORITY","queue_name":"FRAME_LOADING_TQ"}, "renderer_main_thread_task_execution":{"task_type":"TASK_TYPE_NETWORKING","frame_type":"FRAME_TYPE_MAIN_FRAME",…}, "src_file":"mojo/public/cpp/system/simple_watcher.cc","src_func":"Notify"`.

### 3b. When compositor work outranks the rest

49. Selection is strict priority — `base/task/sequence_manager/task_queue_selector.cc:176-207` **[src]** `auto highest_priority = GetHighestPendingPriority(option);` … `TaskQueue::QueuePriority priority = highest_priority.value();` … `ChooseWithPriority<SetOperationOldest>(priority);` — the selector always serves the highest priority that has work; among queues of equal priority, the **oldest** task (enqueue order). The only fairness in the selector is delayed-vs-immediate at the same priority (`task_queue_selector.h:171` `kMaxDelayedStarvationTasks = 3`). There is **no** cross-priority anti-starvation in `base` (the comment at .cc:181-183 "unless we are starving a lower priority" has no code behind it at the pin **[inf from reading 176-207]**).
50. So with everything at `kNormalPriority`, WebSocket tasks, worker messages, timers and BeginMainFrame are served FIFO by post time. A flood of N WebSocket tasks posted before a BeginMainFrame runs before it. **[inf from 49 + table]**
51. `compositor_priority` = reconciliation of two votes — `main_thread_scheduler_impl.cc:2750-2779` **[src]** `ComputeCompositorPriority()`: neither votes → `kNormalPriority`; either votes highest → highest; else the rendering-starvation vote.
52. Use-case vote — `main_thread_scheduler_impl.cc:2909-2945` **[src]**:
    - `UseCase::kCompositorGesture` → `kHighestPriority` if `blocking_input_expected_soon`, else **`return TaskPriority::kLowPriority;`** (2912-2919). **[doc 2915-2918]** "Deprioritizing compositor tasks can improve smoothness, but this can also can increase checkerboarding. This tradeoff is balanced by increasing priority if rendering is being starved".
    - `kSynchronizedGesture`, `kMainThreadCustomInputHandling` → highest only if `main_thread_compositing_is_fast`, else no vote.
    - `kMainThreadGesture`, `kTouchstart`, `kDiscreteInputResponse` → `kHighestPriority`.
    - `kNone`, `kEarlyLoading`, `kLoading` → no vote.
53. Use case is derived from recent input — `main_thread_scheduler_impl.cc:1877-1952` **[src]**: a continuous gesture is "active" for `UserModel::kGestureEstimationLimit` = 100 ms after the last input signal (`user_model.h:22-23`); then `if (any_thread().last_gesture_was_compositor_driven) { if (any_thread().begin_main_frame_on_critical_path) return UseCase::kSynchronizedGesture; else return UseCase::kCompositorGesture; }` (1925-1930) else `kMainThreadCustomInputHandling`/`kMainThreadGesture`. `last_gesture_was_compositor_driven` is set from `GestureScrollUpdate`/`MouseWheel`/drag `MouseMove` being `EVENT_CONSUMED_BY_COMPOSITOR` (1386-1423). `begin_main_frame_on_critical_path` comes from the BeginFrameArgs (1026), which cc sets to `!ImplLatencyTakesPriority()` (`cc/scheduler/scheduler.cc:629`).
54. Rendering-starvation vote (the M154 form of "prioritize compositing after delay") — state machine updated after every task, `main_thread_scheduler_impl.cc:2865-2907` **[src]**:
    - a BeginMainFrame task ran → `kNone`, `last_frame_time = task end` (2878-2885).
    - a discrete input task ran → `kWaitingForInputResponse` (2888-2893).
    - `rendering_blocking_duration_since_last_frame >= kRenderBlockingStarvationThreshold` → `kRenderingStarvedByRenderBlocking` (2894-2898).
    - `if (task_timing.end_time() - main_thread_only().last_frame_time >= kDefaultRenderingStarvationThreshold) { … = RenderingPrioritizationState::kRenderingStarved; }` (2900-2903).
    Constants `main_thread_scheduler_impl.h:118-119,124-125` **[src]** `kDefaultRenderingStarvationThreshold = base::Milliseconds(100);` `kRenderBlockingStarvationThreshold = base::Milliseconds(500);`.
    Votes (`.cc:2947-2963`): `kRenderingStarved` → `kVeryHighPriority`; `…ByRenderBlocking` → `kExtremelyHighPriority`; `kWaitingForInputResponse` → `kHighestPriority`.
    There is **no feature flag** on this path at the pin: no `PrioritizeCompositingAfterDelay` symbol exists in `main_thread_scheduler_impl.cc`, `scheduler/common/features.{h,cc}` or `blink/common/features.cc` **[src: grep at pin]**. The 100 ms threshold is unconditional.
55. This is the anti-starvation for rendering **[inf from 49, 51, 54]**: under a normal-priority flood with no input (`UseCase::kNone`), BeginMainFrame competes FIFO at normal priority; once **100 ms** have passed since the end of the last BeginMainFrame task, the compositor queue is raised to `kVeryHighPriority` and the next BeginMainFrame jumps the whole normal-priority backlog. The check runs only when a task *completes* (2852), so one long task still delays it. Expected floor under a flood of short tasks: roughly one main frame per 100 ms plus the running task (≈10 fps), not 0.
    During a compositor-driven scroll the queue sits at **`kLowPriority`** for the first 100 ms after each main frame (every normal-priority task outranks BeginMainFrame), then `kVeryHighPriority`. **[obs]** sample traces show `COMPOSITOR_TQ` at `NORMAL_PRIORITY`, `HIGHEST_PRIORITY` and `VERY_HIGH_PRIORITY`.
56. Discrete input (click/key) deferral — `third_party/blink/common/features.cc:413` **[src]** `BASE_FEATURE(kDeferRendererTasksAfterInput, base::FEATURE_ENABLED_BY_DEFAULT);` with default policy `TaskDeferralPolicy::kAllTypes` (439-444). After a discrete input task whose frame is expected, use case becomes `kDiscreteInputResponse` for up to `kDiscreteInputResponseDeadline` = 50 ms (`user_model.h:38-39`) or until the next BeginMainFrame (`main_thread_scheduler_impl.cc:2833-2838`). During it `Policy::IsQueueEnabled` returns false for queues with `CanBeDeferredForRendering()` (`:2126-2131`), which under `kAllTypes` is every per-frame task type except `kInternalInspector`, `kInternalNavigationCancellation`, `kInternalPostMessageForwarding`, `kInternalAutofill` (`frame_scheduler_impl.cc:1463-1495`). So for ≤50 ms after a click, WebSocket (`kNetworking`), `kPostedMessage` and timer queues are **disabled** and BeginMainFrame runs at highest priority. **[inf combining those sites]** A WebSocket flood therefore hurts scroll/idle rendering more than click response.
57. `UseCase::kTouchstart` disables queues with `CanBeDeferred()` (`main_thread_scheduler_impl.cc:2122-2124`): loading (`kNetworking`), deferrable (`kWebSocket`, immediate timers), throttleable — but **not** pausable (`kPostedMessage`): **[doc]** `frame_scheduler_impl.cc:565-566` "PostedMessage can be used for navigation, so we shouldn't defer it when expecting a user gesture."
58. Idle/low-priority work: V8 GC tasks run on `V8_USER_VISIBLE_TQ` at `LOW_PRIORITY` (`main_thread_scheduler_impl.cc:318-323` `QueueType::kV8UserVisible … PrioritisationType::kLow`); **[obs]** `src_func:"void v8::internal::MinorGCJob::TryScheduleTask()"`.

### 3c. Trace events that expose queue, priority, task type and queue time

59. `base/task/sequence_manager/thread_controller_with_message_pump_impl.cc:456` **[src]** — `TRACE_EVENT0(TRACE_DISABLED_BY_DEFAULT("devtools.timeline"), "RunTask");` — one per task on every sequence-manager thread, no args. **[doc 453-455]** "Trace-parsing tools (DevTools, Lighthouse, etc) consume this event to determine long tasks."
60. `…thread_controller_with_message_pump_impl.cc:478-486` + `base/task/common/task_annotator.h:102-113` **[src]** — `task_annotator_.RunTask("ThreadControllerImpl::RunTask", selected_task->task, …)` → `TRACE_EVENT("toplevel", event_name, …)` — the same task again in `toplevel`, with typed args. (The file `thread_controller_impl.cc` no longer exists at the pin; only the event name survives.)
    - posted-from location: JSON `args.src_file`, `args.src_func`, `args.src_line` **[obs]** (`task_annotator.cc:261-265` `set_posted_from_iid`). For anything arriving over mojo it is generic — `simple_watcher.cc`/`Notify` (handle became readable; used both for message pipes and data pipes) or `connector.cc`/`PostDispatchNextMessageFromPipe` (`connector.cc:586-590`, the next queued message) — so the *interface* must be read from the child slice (item 65).
    - `args.sequence_manager_task.{priority,queue_name}` — only when category **`scheduler`** is enabled: `base/task/sequence_manager/sequence_manager_impl.cc:446-457` **[src]** `if (!TRACE_EVENT_CATEGORY_ENABLED("scheduler")) return;` … `set_priority(…)` `set_queue_name(selected_task.task_queue_name)`. `priority` is the priority the task was *selected* at, so it records `compositor_priority` per BeginMainFrame.
    - `args.renderer_main_thread_task_execution.{task_type,frame_type,frame_visible,page_visible,is_ad_frame}` — also gated on `scheduler`: `…/main_thread/main_thread_task_queue.cc:145-158` **[src]**. Enum names `TASK_TYPE_*` from `scheduler/common/tracing_helper.cc:34-…` (`TASK_TYPE_NETWORKING`, `TASK_TYPE_WEB_SOCKET`, `TASK_TYPE_POSTED_MESSAGE`, `TASK_TYPE_JAVASCRIPT_TIMER_DELAYED_LOW_NESTING`, `TASK_TYPE_MAIN_THREAD_TASK_QUEUE_COMPOSITOR`, `TASK_TYPE_MAIN_THREAD_TASK_QUEUE_INPUT`, …).
    - `args.chrome_task_annotator.{task_delay_us,delay_policy}` for delayed tasks (`task_annotator.cc:315-325`); `ipc_hash` only with `disabled-by-default-toplevel.ipc` (327-337).
61. Queue time. `ThreadControllerImpl::RunTask` does **not** carry the task's queueing time **[src: `task_annotator.h:107-112` emits only location, delay, flow, ipc hash; obs: no such key]**. Sources of queue time:
    - `args.current_task.{task_queueing_time_us,task_queued_time_us,task_start_time_us,event_offset_from_task_start_time_us}` on events that call `base::TaskAnnotator::EmitTaskTimingDetails` (`task_annotator.cc:279-311` **[src]**) — at the pin that is the `Graphics.Pipeline` steps (item 20), not arbitrary tasks.
    - `begin_main_sent_to_started_us` (item 8) and the `SendBeginMainFrame` → `ProxyMain::BeginMainFrame` gap (item 32) for BeginMainFrame.
    - Flow arrows post→run need category `toplevel.flow` (`task_annotator.cc:269-276` `if (!TRACE_EVENT_CATEGORY_ENABLED("toplevel.flow")) return;`) — not in the requested list.
    - For WebSocket: no post timestamp exists in the renderer trace; compare network-service-side events (item 77) with the renderer `WebSocketReceive` ts, or timestamp messages at the server.
62. Long tasks: `sequence_manager_impl.cc:848-855` **[src]** — `task_timing.wall_duration() > kLongTaskTraceEventThreshold` (50 ms, line 104) → `TRACE_EVENT_INSTANT("blink", "LongTask", "duration", …InSecondsF())`; JSON **[obs]** `{"name":"LongTask","cat":"blink","args":{"duration":0.250154}}` at the task's end. Also `LongTaskTracker` in `scheduler.long_tasks` (`task_annotator.cc:389-397`).
63. Scheduler state tracks (need extra categories): `main_thread_scheduler_impl.h:754,805,807` **[src]** `TraceableState<UseCase, "renderer.scheduler.status"> current_use_case;` `TraceableState<TaskPriority, "renderer.scheduler"> compositor_priority;` `TraceableState<RenderingPrioritizationState, "renderer.scheduler"> main_frame_prioritization_state;` with track names `Scheduler.UseCase` (`.cc:496`), `Scheduler.CompositorPriority` (557), `RenderingPrioritizationState` (564). Both categories are plain (not disabled-by-default): `base/trace_event/builtin_categories.h:239-240`. Without them, infer compositor priority from `sequence_manager_task.priority` on `COMPOSITOR_TQ` tasks (item 60).
64. Other `renderer.scheduler`-family events: `BlinkScheduler_OnTaskCompleted` (`renderer.scheduler`, `main_thread_scheduler_impl.cc:2616`), `BlinkScheduler_PerformMicrotaskCheckpoint` (`toplevel`, 1264), `MainThreadSchedulerImpl::WillBeginFrame` / `DidCommitFrameToCompositor` / `DidHandleInputEventOnMainThread` (`disabled-by-default-renderer.scheduler`, 990-991, 1032-1033, 1472-1473).
65. Mojo dispatch slice inside the task: `mojo/public/cpp/bindings/lib/interface_endpoint_client.cc:942-944` **[src]** `TRACE_EVENT("toplevel,mojom", perfetto::StaticString{method_name_callback_(*message)}, …set_chrome_mojo_event_info())`. Generated name is `"Receive <namespace>::<Interface>::<Method>"` only when `MOJO_TRACE_ENABLED`; otherwise `"Receive mojo message"` (`mojo/public/tools/bindings/generators/cpp_templates/interface_definition.tmpl:124,142`). **[obs]** the 154.0.8037.57 build emits `"Receive mojo message"` with `args.chrome_mojo_event_info.mojo_interface_tag:"network.mojom.WebSocketClient"` — grep the tag, not the name. Data-pipe readiness: `mojo/public/cpp/system/simple_watcher.cc:278` `"SimpleWatcher::OnHandleReady"` (`toplevel`) with `watcher_notify_interface_tag`.

---

## 4. WebSocket receive path

### 4a. Order of hops

66. Network service, `net::WebSocketChannel` reads frames from the socket only while the consumer has no backlog — `net/websockets/websocket_channel.cc:611-651` **[src]** `while (!event_interface_->HasPendingDataFrames()) { … stream_->ReadFrames(&read_frames_, …) …}`; each data frame → `event_interface_->OnDataFrame(final, opcode_to_send, payload);` (858). (Thread: the network service's IO thread **[inf]**, not read.)
67. `network::WebSocket` forwards **metadata over a mojo message pipe and payload over a mojo data pipe** — `services/network/websocket.cc:410-422` **[src]** `impl_->client_->OnDataFrame(fin, OpCodeToMessageType(type), payload.size());` `impl_->pending_data_frames_.push(payload);` `impl_->SendPendingDataFrames(InterruptionReason::kNone);`. Data pipe capacity: `:69-70` `kReceiveDataPipeCapacity = BUILDFLAG(IS_ANDROID) ? 1 << 16 : 131000;` (bytes), created at 362-367.
68. **Backpressure #1 (the only one before JS):** `services/network/websocket.cc:840-847` **[src]** — after `SendDataFrame`, `if (data_frame.size() > 0) { // Mojo doesn't have any write buffer so far.` `writable_watcher_.ArmOrNotify(); … incoming_frames_interrupted_ = InterruptionReason::kMojoPipe; return; }`; `HasPendingDataFrames()` (430) is then true, so `WebSocketChannel::ReadFrames` stops reading the socket (item 66) until the renderer drains the pipe (`OnWritable` → 807 → `channel_->ReadFrames()` 851). The TCP receive window then fills and the server is throttled **[inf]**. So the renderer-side backlog is bounded to ~131 kB of payload plus the queued `OnDataFrame` messages for frames already written — with small frames that can still be thousands of messages.
69. `StartReceiving` is a one-time gate, not flow control — `websocket.cc:671-674` **[src]** `void WebSocket::StartReceiving() { … channel_->ReadFrames(); }`; the renderer calls it once after the handshake throttle passes (`websocket_channel_impl.cc:625,959`). **[doc]** `services/network/public/mojom/websocket.mojom:140-143` "Let browser to start receiving WebSocket data frames from network stream."
70. Renderer, main thread: `blink::WebSocketChannelImpl` is the mojo `WebSocketClient`, bound on the frame's `kNetworking` runner (table 3a). `websocket_channel_impl.cc:630-645` **[src]** `OnDataFrame` → `pending_data_frames_.emplace_back(fin, type, …);` `ConsumePendingDataFrames();`. For a `DOMWebSocket` created in a window everything from here on is on `CrRendererMain`; in a worker the same code runs on the worker thread (the execution context's runners) **[inf from `execution_context->GetTaskRunner`]**. There is no compositor/IO-thread stage in the renderer for the frame payload **[inf: receiver and watcher are both bound to main-thread runners, items 3a]**.
71. `websocket_channel_impl.cc:1038-1082` **[src]** — `while (!pending_data_frames_.empty() && !backpressure_ && GetState() == State::kOpen) { … readable_->BeginReadData(…) … if (begin_result == MOJO_RESULT_SHOULD_WAIT) { readable_watcher_.ArmOrNotify(); return; } … ConsumeDataFrame(…) … pending_data_frames_.pop_front(); continue; }` — a **loop**: every queued frame whose bytes are already in the pipe is consumed in the same task.
72. `websocket_channel_impl.cc:1143-1175` **[src]** — non-final frames are appended to `message_chunks_`; on `fin`: `probe::DidReceiveWebSocketMessage`, the `WebSocketReceive` trace instant, then `client_->DidReceiveTextMessage(message);` / `DidReceiveBinaryMessage(chunks)`.
73. `modules/websockets/dom_websocket.cc:531-542,84-89` **[src]** — `event_queue_->Dispatch(MessageEvent::Create(msg, origin_));` → `case kActive: … target_->DispatchEvent(*event);` — the `message` event is dispatched **synchronously** inside that loop; the JS handler runs as a `FunctionCall` slice (`bindings/core/v8/v8_script_runner.cc:840`, `devtools.timeline`). No `EventDispatch` slice: that event comes from `EventDispatcher` for DOM nodes (`core/dom/events/event_dispatcher.cc:258`), and `event_target.cc` has no trace event at the pin **[src: grep]**.
74. Can several messages arrive in one main-thread task? **Yes** **[inf from 70-73]**. Each `OnDataFrame` mojo message is normally its own task (`mojo/public/cpp/bindings/lib/connector.cc:586-614,653-657`: remaining messages are re-posted one task each unless `should_dispatch_messages_immediately()`), and usually finds its bytes present, giving one message per task. But when a frame's bytes are not yet readable (`SHOULD_WAIT`), later `OnDataFrame` tasks only queue; the eventual `OnReadable` task (`:1026-1036`, posted from `simple_watcher.cc`) drains **all** of them in one task: N `WebSocketReceive` + N handler calls under one `RunTask`. Likewise one task can finish a multi-frame message. Microtasks run after each handler call, not once per task **[inf, not read]**.
    **[obs]** in the sample trace the common shape is `RunTask` → `ThreadControllerImpl::RunTask` (`FRAME_LOADING_TQ`, `src_func:"Notify"`) → `SimpleWatcher::OnHandleReady` (`watcher_notify_interface_tag:"network.mojom.WebSocketClient"`) → `Receive mojo message` (`mojo_interface_tag:"network.mojom.WebSocketClient"`, i.e. the `OnDataFrame` message) → `WebSocketReceive`, one message per task (30 receives, 30 such tasks). A task with several `WebSocketReceive` instants, or `WebSocketReceive` under a `SimpleWatcher::OnHandleReady` with no `Receive mojo message` child (the data-pipe `OnReadable` path), is the batching case; I did not observe one in the samples.
75. JS has no backpressure: the only renderer-side throttle is `backpressure_`, set by `ApplyBackpressure()` (`websocket_channel_impl.cc:535-538`), whose callers are all in `websocket_stream.cc:199,217,681` (the `WebSocketStream` API); `dom_websocket.cc` never calls it **[src: grep at pin]**. A slow `onmessage` handler delays *task completion*, and only that (through items 68, 71) slows the socket. Events are queued in Blink only while the context is paused (`dom_websocket.cc:90-93`).

### 4b. Send path (brief)

76. `dom_websocket.cc:330-349` **[src]** `buffered_amount_ += encoded_message.length(); channel_->Send(encoded_message, nullptr);` → `websocket_channel_impl.cc:416-428` (`WebSocketSend` instant) → `SendFromMemory` 793 → `MaybeSendSynchronously` 827-836 (`websocket_->SendMessage(frame_type, data->size());` + write into the data pipe) or queue in `messages_` when the pipe is full (`wait_for_writable_ = true;` 899). Each chunk written calls `client_->DidConsumeBufferedAmount(…)` (895) → `consumed_buffered_amount_ += consumed; PostBufferedAmountUpdateTask();` (`dom_websocket.cc:586-594`), and `bufferedAmount` drops only when that `kWebSocket` task runs (297-322) **[obs: `FRAME_DEFERRABLE_TQ`, `src_func:"PostBufferedAmountUpdateTask"`]** or at the next receive (`ReflectBufferedAmountConsumption()` 534). `bufferedAmount` getter: 447-451. So `bufferedAmount` means "not yet handed to the mojo pipe", not "not yet on the wire".

### 4c. `devtools.timeline` WebSocket events at M154

All are **instants** (`DEVTOOLS_TIMELINE_TRACE_EVENT_INSTANT`, `core/inspector/inspector_trace_events.h:163-165` → `TRACE_EVENT_INSTANT("devtools.timeline", name, "data", …)`), on the thread that owns the socket. Args in `modules/websockets/inspector_websocket_events.cc:20-67` **[src]**: common `data.identifier`, plus `data.frame` (window) or `data.workerId` (worker), plus `data.stackTrace` when a JS stack exists.

| Event | Extra args | Emit site (`websocket_channel_impl.cc`) | Frequency |
|---|---|---|---|
| `WebSocketCreate` | `url`, `webSocketProtocol` | 410-412 (`Connect`) | once per socket |
| `WebSocketSendHandshakeRequest` | — | 554-556 (`OnOpeningHandshakeStarted`) | once |
| `WebSocketReceiveHandshakeResponse` | — | 582-584 (`OnConnectionEstablished`) | once |
| `WebSocketSend` | `dataLength` | 423-425 (string), 443-445 (Blob), 461-463 (ArrayBuffer) | **per `send()`** |
| `WebSocketReceive` | `dataLength` | 1157-1159 (`ConsumeDataFrame`, only when `fin`) | **per complete message** |
| `WebSocketDestroy` | — | 513-515 (`Disconnect`), 656-658 (`OnDropChannel`) | once |

77. `WebSocketReceive.dataLength` is `data.size()` of the **final chunk**, not the message size — `websocket_channel_impl.cc:1157-1159` **[src]** `… execution_context_.Get(), identifier_, data.size());` where `data` is the last frame's (or last pipe segment's) bytes while earlier chunks sit in `message_chunks_`. For single-frame messages smaller than the pipe buffer it equals the payload size. JSON **[obs]**: `{"name":"WebSocketReceive","cat":"devtools.timeline","ph":"I","args":{"data":{"dataLength":904,"frame":"9E2A…","identifier":27}}}`.
    Network-service side: no per-frame trace events found in `services/network/websocket.cc` or `net/websockets/websocket_channel.cc` (only `DVLOG` and NetLog `WEBSOCKET_*` events) **[src: grep]**; whether the `netlog` category surfaces per-frame NetLog entries was not verified.
78. DevTools typing: `devtools/front_end/models/trace/types/TraceEvents.ts:3100-3105` **[src]** — the six names above; `:2894` `isWebSocketTraceEvent`.

---

## 5. Worker messaging

79. Main → worker, send side (`CrRendererMain`): `core/workers/dedicated_worker.cc:174-210` **[src]** — `PostMessageHelper::SerializeMessageByMove(…)` (serialization is synchronous inside `postMessage`), `uint64_t trace_id = base::trace_event::GetNextGlobalTraceId();`, `context_proxy_->PostMessageToWorkerGlobalScope(…)`, then `TRACE_EVENT_INSTANT("devtools.timeline", "SchedulePostMessage", "data", …, perfetto::Flow::Global(trace_id));`. Task posted to the worker thread with `TaskType::kPostedMessage` (`core/workers/dedicated_worker_messaging_proxy.cc:169-174`; messages sent before the worker script has evaluated are queued, 165-168).
80. Worker receive side (`DedicatedWorker thread`): `core/workers/worker_global_scope.cc:643-672` **[src]** — `TRACE_EVENT("devtools.timeline", "HandlePostMessage", "data", …, perfetto::Flow::Global(message_event->GetTraceId()));` `DispatchEvent(*message_event);` — a **duration** slice around the worker's `onmessage`.
81. Worker → main, send side (worker thread): `core/workers/dedicated_worker_global_scope.cc:440-473` **[src]** — same pattern, `"devtools.timeline", "SchedulePostMessage"`; cross-thread post at `core/workers/dedicated_worker_object_proxy.cc:64-72` `*GetParentExecutionContextTaskRunners()->Get(TaskType::kPostedMessage)`.
82. Main receive side: `core/workers/dedicated_worker_messaging_proxy.cc:309-337` **[src]** — `TRACE_EVENT("devtools.timeline", "HandlePostMessage", "data", …, perfetto::Flow::Global(event->GetTraceId()));` `worker_object_->DispatchEvent(*event);` on `CrRendererMain`, inside a `FRAME_PAUSABLE_TQ` / `TASK_TYPE_POSTED_MESSAGE` task at normal priority (table 3a). One task per message (one `PostCrossThreadTask` each) — no batching **[inf from 81]**.
83. Args: `core/inspector/inspector_trace_events.cc:1311-1326` **[src]** — both events have `data.traceId` (a decimal **string**); `SchedulePostMessage` also `data.stackTrace`. Pair them by `traceId`: latency = `HandlePostMessage.ts − SchedulePostMessage.ts` = cross-thread hop + receiver queueing. The flow id is also exported as flow events **[inf]**. DevTools: `TraceEvents.ts:249,258,2224-2229`.
84. Transfer vs structured clone is **not** distinguishable from these events: neither payload size nor a transfer list is recorded (item 83), and no trace events exist in `bindings/core/v8/serialization/{serialized_script_value,v8_script_value_serializer,v8_script_value_deserializer,post_message_helper}.cc` **[src: grep at pin, no `TRACE_EVENT`]**. Indirect evidence only **[inf]**: clone cost shows as self time of the `postMessage` call on the sender (serialize) and as time inside `HandlePostMessage` before the handler's `FunctionCall` on the receiver (deserialization is lazy, on first `event.data` read — not verified), and in CPU-profile samples (`disabled-by-default-v8.cpu_profiler`); a transferred `ArrayBuffer` shows near-zero for both.

---

## 6. V8 GC in traces

85. Top-level DevTools events — `v8/src/heap/heap.cc:1402-1415,1529-1531` **[src]** — `TRACE_EVENT_BEGIN("devtools.timeline,v8", perfetto::StaticString(event_name_), "usedHeapSizeBefore", heap_->SizeOfObjects(), "type", event_type);` / `TRACE_EVENT_END("devtools.timeline,v8", "usedHeapSizeAfter", heap_->SizeOfObjects());` with `IsYoungGenerationCollector(collector) ? "MinorGC" : "MajorGC", ToString(gc_reason)`.
    - `MinorGC` = scavenge (or minor mark-sweep); `MajorGC` = the **atomic pause** of a mark-compact (the final pause when marking was incremental).
    - Args: `usedHeapSizeBefore`, `usedHeapSizeAfter` (bytes of live+dead objects before / after), `type` = the GC **reason** string. JSON **[obs]** `{"name":"MinorGC","cat":"devtools.timeline,v8","ph":"X","dur":440,"args":{"type":"allocation failure","usedHeapSizeBefore":4760704,"usedHeapSizeAfter":4163748}}`.
    - Thread: the isolate's own thread — `CrRendererMain` for the page, the worker thread for a worker's isolate. The mutator is paused for the slice's duration.
86. Phase scopes — `v8/src/heap/gc-tracer.h:29-30` **[src]** `#define TRACE_GC_CATEGORIES "devtools.timeline," TRACE_DISABLED_BY_DEFAULT("v8.gc")`; names `v8/src/heap/gc-tracer-inl.h:76-79` `return "V8.GC_" #scope;` over the lists in `v8/src/init/heap-symbols.h` (`TRACER_SCOPES` 1132-1155, `TRACER_BACKGROUND_SCOPES` 1157-1176). Because the category string contains `devtools.timeline`, these appear **without** enabling `disabled-by-default-v8.gc`. Examples: `V8.GC_SCAVENGER` (top scope, arg `epoch`; `heap.cc:2255` `TRACE_GC_EPOCH(tracer(), CollectorScopeId(collector), ThreadKind::kMain);`), `V8.GC_SCAVENGER_SCAVENGE`, `V8.GC_MARK_COMPACTOR`, `V8.GC_MC_MARK`, `V8.GC_MC_SWEEP`, `V8.GC_MC_EVACUATE`, `V8.GC_MC_CLEAR` (`heap-symbols.h:997-1004`), `V8.GC_HEAP_PROLOGUE`, `V8.GC_TIME_TO_SAFEPOINT`, incremental steps `V8.GC_MC_INCREMENTAL` (+ `_START`, `_SWEEPING`, …; 985-993).
87. Background/parallel work appears on **pool threads**: `V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL`, `V8.GC_MC_BACKGROUND_MARKING` (concurrent marking), `V8.GC_MC_BACKGROUND_SWEEPING`, `V8.GC_MC_BACKGROUND_EVACUATE_COPY` (`heap-symbols.h:1164-1174`). **[obs]** on `ThreadPoolForegroundWorker`. These do not block the main thread unless nested inside a main-thread `MinorGC`/`MajorGC` window (parallel phases of a pause).
88. `v8`-category names — `v8/src/heap/heap.cc:1539-1540` **[src]** `TRACE_EVENT("v8", perfetto::StaticString(record_gc_phases_info.trace_event_name()));` with names from `v8/src/heap/gc-tracer.cc:135-178`: `V8.GCScavenger`, `V8.GCMinorMS`, `V8.GCCompactor` (non-incremental full GC), `V8.GCFinalizeMC`, `V8.GCFinalizeMCReduceMemory`, `V8.GCFinalizeMCMeasureMemory`. Incremental marking steps on the main thread: `v8/src/heap/incremental-marking.cc:789` `TRACE_EVENT("v8", "V8.GCIncrementalMarking", "epoch", …)`; start: `heap.cc:1832-1836` `V8.GCIncrementalMarkingStart` / `V8.GCMinorIncrementalMarkingStart` with `value.gc_reason`.
    (The older bare `"V8.GC_*"`-only convention is thus split: dotted-underscore `V8.GC_<SCOPE>` = phase scopes in `devtools.timeline,disabled-by-default-v8.gc`; camel `V8.GC<Name>` = `v8` or `disabled-by-default-v8.gc`.)
89. Extra detail with `disabled-by-default-v8.gc` only (`gc-tracer.cc` **[src]**): instants `V8.GC_Heap_Stats` (503), `V8.GCTraceGCNVP` (1245), `V8.GCSpeedSummary` (1527), `V8.GCMarkCompactorSummary` (1520).
90. Scheduling context: GC *tasks* (idle-time scavenge, incremental marking steps) are posted to Blink's `V8_USER_VISIBLE_TQ` at low priority (item 58), so under a normal-priority flood task-driven GC is starved and collections happen as **allocation-failure** GCs inside whatever JS was running (`type:"allocation failure"`) **[inf from 49, 58 + obs of the reason string]**.
91. DevTools: `TraceEvents.ts:3125-3128` **[src]** `GC = 'GCEvent'`, `DOMGC = 'BlinkGC.AtomicPhase'`, `MAJOR_GC = 'MajorGC'`, `MINOR_GC = 'MinorGC'`. The Oilpan (`BlinkGC.*`/cppgc) emit site was not found at the pin (see "Not verified").

---

## 7. Trace cookbook

Renderer pid = the pid whose `thread_name` metadata has `CrRendererMain`. "Comp" = `Compositor` thread.

| Question | Event name(s) | Category | Thread / process | Arg(s) to read |
|---|---|---|---|---|
| Outcome of vsync N | `PipelineReporter` (`ph:"b"`) | `cc,benchmark,disabled-by-default-devtools.timeline.frame` | Comp, renderer (async; pair `b`/`e` by `id2.local`) | `args.frame_reporter.{frame_sequence,state,frame_type,affects_smoothness,scroll_state}` |
| Did that frame carry a main commit | stage children with same `id2.local`: `SendBeginMainFrameToCommit`, `Commit`, `Activation` | same cat (check cat: other `Commit`s exist) | Comp | presence; durations from `b`/`e` |
| How long main thread took, and where | `SendBeginMainFrameToCommit` | same | Comp | `args.send_begin_mainframe_to_commit_breakdown.{begin_main_sent_to_started_us,handle_input_events_us,animate_us,style_update_us,layout_update_us,prepaint_us,paint_us,composite_commit_us,update_layers_us}` |
| Raster/activation lateness | `EndCommitToActivation`, `Activation` | same | Comp | duration |
| Viz/GPU lateness | `SubmitCompositorFrameToPresentationCompositorFrame` + `SubmitToReceiveCompositorFrame`, `ReceiveCompositorFrameToStartDraw`, `StartDrawToSwapStart`, `Swap`, `SwapEndToPresentationCompositorFrame` | same | Comp (reported there; work is in GPU process) | durations |
| Checkerboard in this frame | `PipelineReporter` | same | Comp | `has_missing_content`, `checkerboarded_needs_raster`, `checkerboarded_needs_record` |
| How many tiles were missing | `LayerTreeHostImpl::CalculateRenderPasses`; `TileBasedLayerImpl::AppendQuads checkerboard` | `cc,benchmark`; `cc` | Comp | `missing tiles`, `draw_result`; `missing_tile_count` |
| Checkerboard/drop totals for a scroll | `FrameSequenceTrackerV3` | `cc,benchmark` | Comp (async) | begin `name`; end `args.data.{expected,dropped_v4,checkerboarded,checkerboarded_need_raster,checkerboarded_need_record}` |
| Vsync started by compositor | `BeginFrame`; `Scheduler::BeginImplFrame` | `disabled-by-default-devtools.timeline.frame`; `cc,benchmark` | Comp | `frameSeqId`; `args.args.{sequence_number,frame_time_us,deadline_us,interval_us}` |
| Main thread missed previous deadline | `Scheduler::BeginImplFrame` | `cc,benchmark` | Comp | `main_thread_missed_last_deadline` |
| Why compositor stopped waiting | `Scheduler::ScheduleBeginImplFrameDeadline` (last before `Scheduler::OnBeginImplFrameDeadline`) | `cc` | Comp | `deadline mode`, `new deadline` |
| BeginMainFrame sent / started | `RequestMainThreadFrame`, `SendBeginMainFrame`; `BeginMainThreadFrame`, `ProxyMain::BeginMainFrame` | `…timeline.frame`, `cc,benchmark` | Comp; CrRendererMain | `layerTreeId`; `begin_frame_id`, `data.frameId` |
| Main frame had nothing to commit | `MainFrameAborted`; `Scheduler::BeginMainFrameAborted` | `cc,benchmark`; `cc` | CrRendererMain; Comp | `args.main_frame_pipeline.aborted_on_main_reason`; `reason` |
| Main-thread commit work | `Commit` | `disabled-by-default-devtools.timeline` | CrRendererMain | `frameSeqId`, `layerTreeId` |
| Compositor drew / activated | `DrawFrame`, `ActivateLayerTree`, `MainFrame.Draw` | `…timeline.frame`; `cc,benchmark` | Comp | `frameSeqId`; `frameId` |
| Vsync with no submit | `DidNotSubmitInLastFrame`; `LayerTreeHostImpl::DidNotProduceFrame` | `cc`; `cc,benchmark` | Comp | `is_waiting_on_main`, `has_pending_tree`; `FrameSkippedReason`, `Frame Sequence Number` |
| BeginFrame discarded by scheduler | `Scheduler::BeginFrameDropped`, `Scheduler::MissedBeginFrameDropped` | `cc` | Comp | — |
| Smoothness-affecting drop (DevTools view) | `DroppedFrame` | `…timeline.frame` | Comp | `frameSeqId`, `hasPartialUpdate` |
| Compositor idle/active | `NeedsBeginFrameChanged` | `…timeline.frame` | Comp | `data.needsBeginFrame` |
| Viz draw → presentation | `Graphics.Pipeline.DrawAndSwap` (async), `Display::DrawAndSwap`, `Display::FrameDisplayed` | `viz,benchmark`; `viz`; `benchmark,viz,disabled-by-default-display.framedisplayed` | VizCompositorThread, GPU process | `status` on end if cancelled |
| Follow one frame across processes | `Graphics.Pipeline` | `viz,benchmark,graphics.pipeline` | all three | `args.chrome_graphics_pipeline.{step,surface_frame_trace_id,display_trace_id}`; `args.current_task.task_queueing_time_us` |
| What each main-thread task was | `ThreadControllerImpl::RunTask` (needs `scheduler` cat for queue info) | `toplevel` | any | `args.sequence_manager_task.{queue_name,priority}`, `args.renderer_main_thread_task_execution.task_type`, `args.src_func`, `args.src_file` |
| Priority BeginMainFrame ran at | same, filter `queue_name:"COMPOSITOR_TQ"` | `toplevel` | CrRendererMain | `sequence_manager_task.priority` (`LOW_/NORMAL_/VERY_HIGH_/HIGHEST_PRIORITY`) |
| Scheduler use case / starvation state | state tracks `Scheduler.UseCase`, `Scheduler.CompositorPriority`, `RenderingPrioritizationState` | `renderer.scheduler.status`, `renderer.scheduler` (add these) | CrRendererMain | state name |
| Long tasks | `RunTask` (dur > 50 ms); `LongTask` | `disabled-by-default-devtools.timeline`; `blink` | CrRendererMain | `dur`; `duration` (s) |
| WebSocket message delivered | `WebSocketReceive` | `devtools.timeline` | CrRendererMain (or worker) | `data.identifier`, `data.dataLength` (last chunk) |
| WebSocket delivery task | `ThreadControllerImpl::RunTask` → `Receive mojo message` / `SimpleWatcher::OnHandleReady` | `toplevel`; `toplevel,mojom` | CrRendererMain | `queue_name:"FRAME_LOADING_TQ"`, `task_type:"TASK_TYPE_NETWORKING"`; `chrome_mojo_event_info.mojo_interface_tag` / `watcher_notify_interface_tag` = `network.mojom.WebSocketClient` |
| Messages per task (batching) | count `WebSocketReceive` inside one `RunTask` | — | CrRendererMain | — |
| WebSocket send | `WebSocketSend` | `devtools.timeline` | CrRendererMain | `data.dataLength` |
| WebSocket lifecycle | `WebSocketCreate`, `WebSocketSendHandshakeRequest`, `WebSocketReceiveHandshakeResponse`, `WebSocketDestroy` | `devtools.timeline` | owning thread | `data.identifier`, `data.url` |
| JS handler time | `FunctionCall`; `v8.callFunction` | `devtools.timeline`; `v8` | owning thread | `data.{functionName,url,lineNumber,columnNumber}` |
| rAF callbacks | `FireAnimationFrame` under `PageAnimator::serviceScriptedAnimations`; request = `RequestAnimationFrame` instant (`core/dom/frame_request_callback_collection.cc:31`) | `devtools.timeline`; `blink,rail` | CrRendererMain | `data.id` (`inspector_trace_events.cc:1027`) |
| Timers | `TimerInstall` (`core/scheduler/dom_timer.cc:353`), `TimerFire` (407, duration), `TimerRemove` (282) | `devtools.timeline` | owning thread | `data.timerId`; install also `data.timeout`, `data.singleShot` (`core/inspector/inspector_trace_events.cc:991-1004`) |
| Worker message sent / handled | `SchedulePostMessage` (instant) / `HandlePostMessage` (duration) | `devtools.timeline` | sender thread / receiver thread | `data.traceId` (string; join key) |
| Scavenge / full-GC pause | `MinorGC` / `MajorGC` | `devtools.timeline,v8` | isolate's thread | `usedHeapSizeBefore`, `usedHeapSizeAfter`, `type` (reason) |
| GC phases, concurrent GC | `V8.GC_<SCOPE>` e.g. `V8.GC_SCAVENGER`, `V8.GC_MC_MARK`, `V8.GC_MC_BACKGROUND_MARKING`, `V8.GC_MC_INCREMENTAL` | `devtools.timeline,disabled-by-default-v8.gc` | main or `ThreadPoolForegroundWorker` | `epoch` |
| Incremental marking steps | `V8.GCIncrementalMarking`, `V8.GCIncrementalMarkingStart`, `V8.GCFinalizeMC`, `V8.GCScavenger` | `v8` | isolate's thread | `epoch`, `value.gc_reason` |
| Input → frame latency | `EventLatency` | `cc,benchmark,input,input.scrolling` | Comp (async) | stage children (`cc/metrics/event_latency_tracing_recorder.cc:255`; not analysed here) |

---

## Not verified at the pin

- **JSON key names** for typed args come from the proto→JSON exporter (Perfetto), which I did not read.
  They are stated from [obs] in Chrome 154.0.8037.57 traces; that build is the same milestone as the
  pin but I did not prove it is the same commit.
- `DroppedFrame`, `MajorGC`, `HandlePostMessage`/`SchedulePostMessage`, `TimerFire`, state tracks: JSON
  shape not observed (absent from the sample traces or category not recorded); names/args are [src] only.
  How `TRACE_STATE` tracks (`Scheduler.UseCase` …) are rendered in JSON is unknown.
- `STEP_BUFFER_SWAP_POST_SUBMIT`, `STEP_FINISH_BUFFER_SWAP`: sites located by grep
  (`components/viz/service/display_embedder/`), surrounding code not read; which thread they run on is [inf].
- The WebSocket batching case (several messages in one task via the data-pipe `OnReadable` path) is
  derived from code only; not observed in the sample traces.
- `MOJO_TRACE_ENABLED` build-flag value in official builds: inferred from [obs] (`"Receive mojo message"`), not read.
- Network service threading (which thread runs `net::WebSocketChannel`), and whether the `netlog`
  category exposes per-frame WebSocket NetLog events: not read.
- WebSocket inside a **worker**: only inferred from the execution-context task runners; the worker
  scheduler's queue/priority mapping for `kNetworking` was not read.
- Mojo `should_dispatch_messages_immediately()` conditions (could batch several `OnDataFrame` messages
  in one task): definition not read.
- Oilpan/cppgc GC events (`BlinkGC.AtomicPhase`, `CppGC.*`): `v8/src/heap/cppgc/stats-collector.h` and
  `trace-event.h` returned 404 at the V8 pin (moved); emit sites not found. Only the DevTools constant is [src].
- V8 flag defaults (Scavenger vs MinorMS for young GC): not read; [obs] shows `V8.GC_SCAVENGER`.
- `cc/debug/benchmark_instrumentation.*` (not in the sparse checkout): the `ScopedBeginFrameTask` event
  names at `proxy_impl.cc:805` were not resolved.
- `features::kNewContentForCheckerboardedScrolls`, `kThrottleRepeatedNoDamageFrames`,
  `scroll_deadline_mode_enabled` defaults: not read ([obs] `WAIT_FOR_SCROLL` occurs, so scroll deadline
  mode is on in that build).
- Lazy deserialization of `MessageEvent.data` and per-callback microtask checkpoints: stated as [inf], not read.
- DevTools: only `FramesHandler.ts`, `TraceEvents.ts` and the frame-title code in
  `TimelineFlameChartDataProvider.ts` were read; other consumers of `PipelineReporter` in the frontend
  were not surveyed.
