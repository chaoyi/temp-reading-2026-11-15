// Turn one Chrome trace (plus the backend's events merged into it) into the
// numbers and thread lanes the course pages draw.
//
// Everything here is derived from recorded events; where a number is an
// inference of this file (for example "frame outcome"), the comment says
// from which events. Times in the result are milliseconds after `t0`: the
// first input after the "trace: start" mark, or the mark itself when the
// scenario has no input.

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function quantiles(xs) {
  if (!xs.length) return { n: 0, p50: null, p95: null, max: null, sum: 0, mean: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(s[s.length - 1]), sum: r2(sum), mean: r3(sum / s.length) };
}

// How DevTools groups main-thread slices; the first matching ancestor wins.
const CATEGORY = {
  // scripting
  EventDispatch: "script", FunctionCall: "script", TimerFire: "script", FireAnimationFrame: "script", RunMicrotasks: "script",
  EvaluateScript: "script", "v8.callFunction": "script", "v8.run": "script", FireIdleCallback: "script", "V8.BytecodeBudgetInterrupt": "script",
  // garbage collection
  MinorGC: "gc", MajorGC: "gc", "V8.GCScavenger": "gc", "V8.GCCompactor": "gc", "V8.GCFinalizeMC": "gc", "V8.GCIncrementalMarking": "gc",
  "V8.GC_SCAVENGER": "gc", "V8.GC_MARK_COMPACTOR": "gc", "V8.GC_MINOR_MS": "gc", "BlinkGC.AtomicPhase": "gc", "V8.GCIncrementalMarkingStart": "gc", "V8.GCIncrementalMarkingFinalize": "gc",
  // style and layout
  UpdateLayoutTree: "style", Layout: "layout", HitTest: "layout", ScrollLayer: "layout", "IntersectionObserverController::computeIntersections": "layout",
  // paint and the hand-over to the compositor
  PrePaint: "paint", Paint: "paint", Layerize: "paint", UpdateLayer: "paint", "PaintArtifactCompositor::Update": "paint", Commit: "commit",
  ParseHTML: "other", ParseAuthorStyleSheet: "other",
};
const KIND = { script: "js", gc: "gc", style: "layout", layout: "layout", paint: "paint", commit: "commit" };

/** Index a trace: thread names, the page's renderer process, the measurement window. */
export function open(trace) {
  const ev = trace.traceEvents;
  const threadName = new Map();
  const processName = new Map();
  for (const e of ev) {
    if (e.ph !== "M") continue;
    if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === "process_name") processName.set(e.pid, e.args.name);
  }
  const startMark = ev.find((e) => e.name?.startsWith("trace: start") && e.cat === "blink.user_timing");
  if (!startMark) throw new Error("no 'trace: start' mark");
  const endMark = ev.find((e) => e.name === "trace: end" && e.cat === "blink.user_timing");
  const pid = startMark.pid; // the page's renderer process
  const tidOf = (p, prefix) => {
    for (const [k, name] of threadName) if (k.startsWith(p + ":") && name.startsWith(prefix)) return Number(k.split(":")[1]);
  };
  const pidOf = (name) => [...processName].find(([, n]) => n === name)?.[0];
  const browserPid = pidOf("Browser");
  const gpuPid = pidOf("GPU Process");
  const backendPid = pidOf("Backend (node)");
  const ids = {
    pid, main: tidOf(pid, "CrRendererMain"), compositor: tidOf(pid, "Compositor"), io: tidOf(pid, "Chrome_ChildIOThread"),
    workers: [...threadName].filter(([k, n]) => k.startsWith(pid + ":") && n.startsWith("DedicatedWorker")).map(([k]) => Number(k.split(":")[1])),
    browserPid, browserMain: tidOf(browserPid, "CrBrowserMain"), gpuPid, viz: tidOf(gpuPid, "VizCompositorThread"), backendPid,
    networkPid: pidOf("Service: network.mojom.NetworkService"),
  };
  return { ev, threadName, processName, ids, startTs: startMark.ts, endTs: endMark?.ts ?? Math.max(...ev.map((e) => e.ts || 0)) };
}

/** Pair async begin/end events ("b"/"e") by category, id and name, as a stack. */
function pairAsync(events) {
  const open = new Map();
  const out = [];
  for (const e of events) {
    if (e.ph !== "b" && e.ph !== "e") continue;
    const key = `${e.cat}|${e.id2?.local ?? e.id2?.global ?? e.id}|${e.name}|${e.pid}`;
    if (e.ph === "b") {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else {
      const b = open.get(key)?.pop();
      if (b) out.push({ name: b.name, cat: b.cat, id: e.id2?.local ?? e.id, pid: b.pid, tid: b.tid, ts: b.ts, dur: e.ts - b.ts, args: b.args, endArgs: e.args });
    }
  }
  const unclosed = [];
  for (const stack of open.values()) for (const b of stack) unclosed.push(b);
  return { spans: out.sort((a, b) => a.ts - b.ts), unclosed };
}

/** Complete ("X") events of one thread as a forest with self times. */
function sliceTree(events) {
  const xs = events.filter((e) => e.ph === "X").sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const roots = [];
  const stack = [];
  for (const e of xs) {
    const node = { e, end: e.ts + (e.dur || 0), children: [], self: e.dur || 0 };
    while (stack.length && stack[stack.length - 1].end < node.end - 0 && stack[stack.length - 1].end <= e.ts) stack.pop();
    while (stack.length && !(stack[stack.length - 1].e.ts <= e.ts && stack[stack.length - 1].end >= node.end)) stack.pop();
    if (stack.length) {
      const parent = stack[stack.length - 1];
      parent.children.push(node);
      parent.self -= node.e.dur || 0;
      node.parent = parent;
    } else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function walk(nodes, fn, depth = 0) {
  for (const n of nodes) {
    fn(n, depth);
    walk(n.children, fn, depth + 1);
  }
}

/** Decode V8's sampled profile for one thread: self and total time per function in [from, to]. */
function cpuProfile(ev, pid, tid, from, to) {
  const nodes = new Map();
  const self = new Map();
  // A "Profile" event names the sampled thread; its chunks share its id and
  // may be written from V8's profiler thread.
  const prof = ev.find((e) => e.name === "Profile" && e.pid === pid && e.tid === tid);
  if (!prof) return { samples: 0, idleMs: 0, self: [], total: [] };
  let t = prof.args.data.startTime;
  let samples = 0;
  for (const e of ev) {
    if (e.name !== "ProfileChunk" || e.pid !== pid || e.id !== prof.id) continue;
    const d = e.args.data;
    for (const n of d.cpuProfile?.nodes ?? []) nodes.set(n.id, n);
    const ids = d.cpuProfile?.samples ?? [];
    for (let i = 0; i < ids.length; i++) {
      const dt = d.timeDeltas[i];
      t += dt;
      // A sample's interval is the time since the previous sample.
      if (t >= from && t <= to) {
        self.set(ids[i], (self.get(ids[i]) ?? 0) + dt);
        samples++;
      }
    }
  }
  const label = (n) => {
    const f = n.callFrame;
    const file = f.url ? f.url.replace(/^https?:\/\/[^/]+\//, "").replace(/-[A-Za-z0-9_]{8}\.js$/, ".js") : "";
    return { fn: f.functionName || "(anonymous)", at: file ? `${file}:${(f.lineNumber ?? 0) + 1}` : "" };
  };
  const bySelf = new Map();
  const byTotal = new Map();
  for (const [id, us] of self) {
    const n = nodes.get(id);
    if (!n) continue;
    const l = label(n);
    const key = `${l.fn}|${l.at}`;
    bySelf.set(key, (bySelf.get(key) ?? 0) + us);
    const seen = new Set();
    for (let a = n; a; a = nodes.get(a.parent)) {
      const la = label(a);
      const k = `${la.fn}|${la.at}`;
      if (seen.has(k)) continue; // recursion: count once
      seen.add(k);
      byTotal.set(k, (byTotal.get(k) ?? 0) + us);
    }
  }
  const top = (m, n) =>
    [...m]
      .filter(([k]) => !k.startsWith("(root)") && !k.startsWith("(idle)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, us]) => ({ fn: k.split("|")[0], at: k.split("|")[1], ms: r2(us / 1000) }));
  const idle = [...bySelf].filter(([k]) => k.startsWith("(idle)")).reduce((a, [, v]) => a + v, 0);
  return { samples, idleMs: r2(idle / 1000), self: top(bySelf, 25), total: top(byTotal, 40) };
}

/**
 * One record per compositor frame, from PipelineReporter (cc/metrics/
 * compositor_frame_reporter.cc). A reporter begins at its BeginFrame and ends
 * when the frame is presented, dropped, or found to need no update.
 */
function frames(asyncSpans, pid) {
  const reporters = asyncSpans.filter((s) => s.name === "PipelineReporter" && s.pid === pid);
  const stages = asyncSpans.filter((s) => s.pid === pid && s.cat?.startsWith("cc,benchmark,disabled-by-default-devtools.timeline.frame") && s.name !== "PipelineReporter");
  const out = [];
  for (const p of reporters) {
    const fr = p.args?.frame_reporter ?? {};
    const mine = stages.filter((s) => s.id === p.id && s.ts >= p.ts && s.ts + s.dur <= p.ts + p.dur + 1);
    const stage = (name) => mine.find((s) => s.name === name);
    const main = stage("SendBeginMainFrameToCommit");
    const breakdown = main?.args?.send_begin_mainframe_to_commit_breakdown;
    out.push({
      forked: fr.frame_type === "FORKED",
      // How long the BeginMainFrame task waited for the main thread (values near 2^63 are unset).
      mainQueueUs: breakdown && breakdown.begin_main_sent_to_started_us < 1e12 ? breakdown.begin_main_sent_to_started_us : null,
      seq: fr.frame_sequence,
      ts: p.ts,
      end: p.ts + p.dur,
      state: { STATE_PRESENTED_ALL: "all", STATE_PRESENTED_PARTIAL: "partial", STATE_DROPPED: "dropped", STATE_NO_UPDATE_DESIRED: "none" }[fr.state] ?? fr.state,
      scroll: fr.scroll_state && fr.scroll_state !== "SCROLL_NONE" ? fr.scroll_state.replace("SCROLL_", "").toLowerCase() : "",
      smooth: !!fr.affects_smoothness,
      missing: !!fr.has_missing_content,
      checker: !!(fr.checkerboarded_needs_raster || fr.checkerboarded_needs_record),
      mainAnim: !!fr.has_main_animation,
      compAnim: !!fr.has_compositor_animation,
      highLatency: !!fr.has_high_latency,
      main: main ? [main.ts, main.ts + main.dur] : null,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Lane specifications: which slices each lane of a chart shows. */
const LANES = {
  browser: { thread: "browserMain", names: { "InputRouterImpl::FilterAndSendWebInputEvent": "input", "RenderWidgetHostImpl::ForwardWheelEvent": "input" } },
  compositor: {
    thread: "compositor",
    names: {
      "WidgetInputHandlerImpl::DispatchEvent": "input",
      "InputHandlerProxy::HandleGestureScrollUpdate": "scroll",
      "ProxyImpl::ScheduledActionDraw": "draw",
      "LayerTreeHostImpl::CommitComplete": "commit",
      "ProxyImpl::ScheduledActionSendBeginMainFrame": "frame",
      "LayerTreeHostImpl::ActivateSyncTree": "commit",
    },
    min: 0,
  },
  frame: { thread: "main", names: { "ProxyMain::BeginMainFrame": "frame" } },
  viz: { thread: "viz", names: { "Display::DrawAndSwap": "draw" } },
};

export function analyze(trace, scenario = {}) {
  const T = open(trace);
  const { ev, ids, threadName } = T;
  const onThread = (e, tid, pid = ids.pid) => e.pid === pid && e.tid === tid;

  // ── time zero and window ──
  const inputs = ev.filter((e) => e.ph === "b" && e.name?.startsWith("InputLatency::") && e.ts >= T.startTs).sort((a, b) => a.ts - b.ts);
  const firstInput = inputs.find((e) => !/MouseMove|MouseEnter|MouseLeave/.test(e.name));
  const t0 = scenario.zero === "start" || !firstInput ? T.startTs : firstInput.ts;
  const t1 = T.endTs;
  const ms = (ts) => r2((ts - t0) / 1000);
  const inWin = (ts) => ts >= T.startTs && ts <= t1;
  const lanesFrom = t0 - (scenario.before ?? 30) * 1000;
  const inLanes = (e) => e.ts + (e.dur || 0) >= lanesFrom && e.ts <= t1;
  const windowMs = (t1 - T.startTs) / 1000;

  // ── main thread: slice tree, categories, tasks ──
  const mainEvents = ev.filter((e) => onThread(e, ids.main));
  const tree = sliceTree(mainEvents.filter((e) => e.ts + (e.dur || 0) >= lanesFrom && e.ts <= t1));
  const cat = { script: 0, gc: 0, style: 0, layout: 0, paint: 0, commit: 0, other: 0 };
  const tasks = [];
  const mainLane = [];
  const counts = { layouts: 0, styleRecalcs: 0, styleElements: 0, layoutDirty: 0, layoutTotalMax: 0, forcedLayouts: 0, forcedStyle: 0, forcedMs: 0, paints: 0, commits: 0, mainFrames: 0, mainFramesAborted: 0, scrollEvents: 0, rafCallbacks: 0, timers: 0, microtaskRuns: 0, hitTests: 0 };
  const taskQueues = new Map();
  walk(tree, (n, depth) => {
    const e = n.e;
    const within = inWin(e.ts);
    // The category of a slice is its own, or its nearest categorized ancestor's.
    let c = null;
    let script = false;
    for (let a = n; a; a = a.parent) {
      const k = CATEGORY[a.e.name];
      if (k && c === null) c = k;
      if (k === "script" && a !== n) script = true;
    }
    if (within && e.name !== "RunTask" && e.name !== "ThreadControllerImpl::RunTask") cat[c ?? "other"] += Math.max(0, n.self);
    if (e.name === "RunTask" && within) tasks.push(e.dur);
    if (e.name === "ThreadControllerImpl::RunTask" && within) {
      const q = e.args?.sequence_manager_task?.queue_name ?? "?";
      const rec = taskQueues.get(q) ?? { n: 0, ms: 0 };
      rec.n++;
      rec.ms += e.dur / 1000;
      taskQueues.set(q, rec);
    }
    if (within) {
      if (e.name === "Layout") {
        counts.layouts++;
        counts.layoutDirty += e.args?.beginData?.dirtyObjects ?? 0;
        counts.layoutTotalMax = Math.max(counts.layoutTotalMax, e.args?.beginData?.totalObjects ?? 0);
        // A layout with JavaScript above it on the stack was forced by that JavaScript.
        if (script) (counts.forcedLayouts++, (counts.forcedMs += e.dur / 1000));
      }
      if (e.name === "UpdateLayoutTree") {
        counts.styleRecalcs++;
        counts.styleElements += e.args?.elementCount ?? 0;
        if (script) (counts.forcedStyle++, (counts.forcedMs += e.dur / 1000));
      }
      if (e.name === "Paint") counts.paints++;
      if (e.name === "Commit") counts.commits++;
      if (e.name === "ProxyMain::BeginMainFrame") counts.mainFrames++;
      if (e.name === "MainFrameAborted") counts.mainFramesAborted++;
      if (e.name === "EventDispatch" && e.args?.data?.type === "scroll") counts.scrollEvents++;
      if (e.name === "FireAnimationFrame") counts.rafCallbacks++;
      if (e.name === "TimerFire") counts.timers++;
      if (e.name === "RunMicrotasks") counts.microtaskRuns++;
      if (e.name === "HitTest") counts.hitTests++;
    }
    // Lane: the outermost slice of each kind (a FunctionCall inside an
    // EventDispatch is not drawn twice). Style or layout with JavaScript
    // above it is drawn as "forced".
    const own = CATEGORY[e.name];
    if (own && KIND[own] && inLanes(e) && (e.dur >= 20 || e.name === "EventDispatch")) {
      let covered = false;
      for (let a = n.parent; a && !covered; a = a.parent) covered = KIND[CATEGORY[a.e.name]] === KIND[own];
      if (!covered) {
        let label = e.name;
        if (e.name === "EventDispatch") label = "Event: " + (e.args?.data?.type ?? "?");
        if (e.name === "FunctionCall") label = "Function call " + (e.args?.data?.functionName || "(anonymous)");
        if (e.name === "Layout") label = `Layout (${e.args?.beginData?.dirtyObjects ?? "?"} of ${e.args?.beginData?.totalObjects ?? "?"} objects dirty)`;
        if (e.name === "UpdateLayoutTree") label = `Recalculate style (${e.args?.elementCount ?? "?"} elements)`;
        const forced = script && (own === "layout" || own === "style");
        mainLane.push([ms(e.ts), r3(e.dur / 1000), forced ? "forced" : KIND[own], label]);
      }
    }
  });
  const longTasks = tasks.filter((d) => d >= 50_000);
  const busy = tasks.reduce((a, b) => a + b, 0) / 1000;

  // ── user timing: measures (async pairs) and marks ──
  const user = ev.filter((e) => e.cat === "blink.user_timing");
  const { spans: measures } = pairAsync(user);
  const detail = (args) => {
    const d = args?.data?.detail ?? args?.detail;
    if (typeof d !== "string") return d ?? {};
    try {
      return JSON.parse(d);
    } catch {
      return {};
    }
  };
  const app = measures.filter((m) => m.name.startsWith("app: ")).map((m) => ({ name: m.name.replace(/ #\d+$/, "").slice(5), full: m.name.slice(5), ts: m.ts, dur: m.dur, tid: m.tid, d: detail(m.args) }));
  const marks = user.filter((e) => (e.ph === "I" || e.ph === "R" || e.ph === "n") && e.name.startsWith("app: ")).map((e) => ({ name: e.name.replace(/ #\d+$/, "").slice(5), full: e.name.slice(5), ts: e.ts, d: detail(e.args) }));
  const appStats = {};
  for (const name of new Set(app.map((a) => a.name))) appStats[name] = quantiles(app.filter((a) => a.name === name && inWin(a.ts)).map((a) => a.dur / 1000));
  const markCounts = {};
  for (const m of marks) if (inWin(m.ts)) markCounts[m.name] = (markCounts[m.name] ?? 0) + 1;

  // ── compositor frames ──
  const frameCats = ev.filter((e) => e.pid === ids.pid && (e.ph === "b" || e.ph === "e") && e.cat?.startsWith("cc,benchmark"));
  const { spans: frameSpans } = pairAsync(frameCats);
  const allFrames = frames(frameSpans, ids.pid);
  const fr = allFrames.filter((f) => inWin(f.ts));
  // One vsync can have several reporters (a main-thread frame and a
  // compositor-only one, or a forked pair). Per vsync, the worst outcome
  // among its reporters is what the user got at that vsync.
  const bySeq = new Map();
  for (const f of fr) (bySeq.get(f.seq) ?? bySeq.set(f.seq, []).get(f.seq)).push(f);
  const rank = { dropped: 3, partial: 2, all: 1, none: 0 };
  const vsync = [...bySeq.values()].map((rs) => {
    const worst = rs.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
    return { seq: worst.seq, ts: Math.min(...rs.map((r) => r.ts)), state: worst.state, smooth: rs.some((r) => r.smooth && r.state !== "all" && r.state !== "none"), missing: rs.some((r) => r.missing), checker: rs.some((r) => r.checker), scroll: rs.find((r) => r.scroll)?.scroll ?? "", presentedAt: Math.max(0, ...rs.filter((r) => r.state === "all" || r.state === "partial").map((r) => r.end)) };
  }).sort((a, b) => a.ts - b.ts);
  const presented = vsync.filter((f) => f.presentedAt);
  const wanted = vsync.filter((f) => f.state !== "none");
  const count = (state) => vsync.filter((f) => f.state === state).length;
  const beginFrames = ev.filter((e) => e.name === "BeginFrame" && onThread(e, ids.compositor) && inWin(e.ts)).length;
  const gaps = [];
  for (let i = 1; i < presented.length; i++) gaps.push((presented[i].presentedAt - presented[i - 1].presentedAt) / 1000);
  const interval = ev.find((e) => e.name === "Scheduler::BeginFrame" && e.pid === ids.pid)?.args?.args?.interval_us ?? 16666;
  const dropInstants = ev.filter((e) => e.name === "DroppedFrame" && e.pid === ids.pid && inWin(e.ts));
  const frameStats = {
    intervalMs: r2(interval / 1000),
    vsyncs: beginFrames,
    reporters: fr.length,
    // per vsync, from PipelineReporter states:
    all: count("all"), partial: count("partial"), dropped: count("dropped"), noUpdate: count("none"),
    partialPct: wanted.length ? r2((100 * count("partial")) / wanted.length) : 0,
    droppedPct: wanted.length ? r2((100 * count("dropped")) / wanted.length) : 0,
    smoothnessHit: vsync.filter((f) => f.smooth).length, // partial or dropped while a scroll or animation was running
    missingContent: vsync.filter((f) => f.missing).length,
    checkerboarded: vsync.filter((f) => f.checker).length,
    // what DevTools' Frames track shows (DroppedFrame instants):
    devtoolsDropped: dropInstants.filter((e) => !e.args?.hasPartialUpdate).length,
    devtoolsPartial: dropInstants.filter((e) => e.args?.hasPartialUpdate).length,
    presentGap: quantiles(gaps),
    mainFrames: fr.filter((f) => f.main).length,
    mainQueueMs: quantiles(fr.filter((f) => f.mainQueueUs != null).map((f) => f.mainQueueUs / 1000)),
    mainFrameMs: quantiles(fr.filter((f) => f.main).map((f) => (f.main[1] - f.main[0]) / 1000)),
  };
  /** When did work done on the main thread at `ts` reach the screen? The first presented frame whose main-frame stage started at or after it, or contains it. */
  const mainFrames = allFrames.filter((f) => f.main && (f.state === "all" || f.state === "partial")).sort((a, b) => a.main[0] - b.main[0]);
  const presentAfter = (ts) => {
    // The main frame that picks up a change made at `ts` is the first whose BeginMainFrame work ends after ts.
    for (const f of mainFrames) if (f.main[1] >= ts) return f.end;
    return null;
  };

  // ── input latency (EventLatency: input generation → presentation, cc/metrics/event_metrics.cc) ──
  const { spans: evl } = pairAsync(ev.filter((e) => e.name === "EventLatency" && e.pid === ids.pid));
  const evlIn = evl.filter((s) => inWin(s.ts));
  const byType = {};
  for (const s of evlIn) {
    const type = s.args?.event_latency?.event_type ?? "?";
    (byType[type] ??= []).push(s.dur / 1000);
  }
  const eventLatency = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, quantiles(v)]));

  // ── scroll content: when was the right content in the DOM, and on screen? ──
  const complete = marks.filter((m) => m.name === "content complete");
  const lastInput = inputs.filter((e) => !/MouseMove/.test(e.name)).at(-1);
  const content = {
    completeMarks: complete.filter((m) => inWin(m.ts)).length,
    firstCompleteMs: complete.find((m) => m.ts >= t0) ? ms(complete.find((m) => m.ts >= t0).ts) : null,
    lastCompleteMs: complete.length ? ms(complete.at(-1).ts) : null,
    lastInputMs: lastInput ? ms(lastInput.ts) : null,
  };
  const tops = complete.filter((m) => inWin(m.ts) && typeof m.d.scrollTop === "number");
  if (tops.length > 3) {
    // The speed the scroll really had, from the positions our marks recorded.
    const a = tops[0];
    const moving = tops.filter((m) => m.d.scrollTop !== tops.at(-1).d.scrollTop);
    const b = moving.at(-1) ?? tops.at(-1);
    content.scrolledPx = Math.round(tops.at(-1).d.scrollTop - a.d.scrollTop);
    content.scrollMs = r2((b.ts - a.ts) / 1000);
    content.pxPerSec = content.scrollMs > 0 ? Math.round(((b.d.scrollTop - a.d.scrollTop) * 1e6) / (b.ts - a.ts)) : null;
  }
  content.settleMs = content.lastCompleteMs != null && content.lastInputMs != null ? r2(content.lastCompleteMs - content.lastInputMs) : null;
  const lastCompletePresent = complete.length ? presentAfter(complete.at(-1).ts) : null;
  content.lastCompleteOnScreenMs = lastCompletePresent ? ms(lastCompletePresent) : null;

  // ── WebSocket request/response ──
  const rt = app.filter((a) => a.name === "ws round trip" && inWin(a.ts));
  const ws = {
    requests: markCounts["ws request"] ?? 0,
    cancels: markCounts["ws cancel"] ?? 0,
    roundTrip: quantiles(rt.map((a) => a.dur / 1000)),
    serverWait: quantiles(rt.filter((a) => a.d.srvStart).map((a) => (a.d.srvStart - a.d.srvRecv) / 1000)),
    serverService: quantiles(rt.filter((a) => a.d.srvDone).map((a) => (a.d.srvDone - a.d.srvStart) / 1000)),
    // Both ends are on the trace clock: request mark → server receive, server done → reply handled.
    upMs: quantiles(rt.filter((a) => a.d.srvRecv).map((a) => (a.d.srvRecv - a.ts) / 1000)),
    downMs: quantiles(rt.filter((a) => a.d.srvDone).map((a) => (a.ts + a.dur - a.d.srvDone) / 1000)),
    bytes: rt.reduce((a, b) => a + (b.d.bytes ?? 0), 0),
    parse: appStats["ws parse"] ?? quantiles([]),
  };

  // ── ticks: how old was the data when handled, applied, and shown? ──
  const tickMsgs = marks.filter((m) => m.name === "tick message" && inWin(m.ts));
  const applies = app.filter((a) => a.name === "tick apply" && inWin(a.ts));
  const ageHandled = tickMsgs.filter((m) => m.d.sentUs).map((m) => (m.ts - m.d.sentUs) / 1000);
  const half = Math.floor(ageHandled.length / 2);
  const ticks = {
    messages: tickMsgs.length,
    applies: applies.length,
    cellsApplied: applies.reduce((a, b) => a + (b.d.cells ?? 0), 0),
    perSecondHandled: r2(tickMsgs.length / (windowMs / 1000)),
    ageWhenHandled: quantiles(ageHandled),
    // Is the backlog growing? Compare the first and second half of the run.
    ageFirstHalf: quantiles(ageHandled.slice(0, half)).p50,
    ageSecondHalf: quantiles(ageHandled.slice(half)).p50,
    ageWhenApplied: quantiles(applies.filter((a) => a.d.oldestUs).map((a) => (a.ts + a.dur - a.d.oldestUs) / 1000)),
    ageOnScreen: quantiles(
      applies
        .filter((a) => a.d.oldestUs)
        .map((a) => [presentAfter(a.ts + a.dur), a.d.oldestUs])
        .filter(([p]) => p)
        .map(([p, o]) => (p - o) / 1000),
    ),
    apply: appStats["tick apply"] ?? quantiles([]),
  };

  // ── garbage collection, raster, counters ──
  const gcMain = mainEvents.filter((e) => e.ph === "X" && (e.name === "MinorGC" || e.name === "MajorGC") && inWin(e.ts));
  const gc = {
    minor: gcMain.filter((e) => e.name === "MinorGC").length,
    minorMs: r2(gcMain.filter((e) => e.name === "MinorGC").reduce((a, e) => a + e.dur, 0) / 1000),
    major: gcMain.filter((e) => e.name === "MajorGC").length,
    majorMs: r2(gcMain.filter((e) => e.name === "MajorGC").reduce((a, e) => a + e.dur, 0) / 1000),
  };
  const rasterEv = ev.filter((e) => e.name === "RasterTask" && e.pid === ids.pid && inWin(e.ts));
  const raster = { tasks: rasterEv.length, ms: r2(rasterEv.reduce((a, e) => a + e.dur, 0) / 1000) };
  const counters = mainEvents.filter((e) => e.name === "UpdateCounters" && inWin(e.ts)).map((e) => e.args.data);
  const heap = counters.length
    ? { minMb: r2(Math.min(...counters.map((c) => c.jsHeapSizeUsed)) / 1e6), maxMb: r2(Math.max(...counters.map((c) => c.jsHeapSizeUsed)) / 1e6), nodesMax: Math.max(...counters.map((c) => c.nodes)), listenersMax: Math.max(...counters.map((c) => c.jsEventListeners)) }
    : null;

  // ── other threads ──
  const threadBusy = (pid, tid) => {
    const xs = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask" || e.name === "ThreadPool_RunTask") && inWin(e.ts));
    const top = sliceTree(xs);
    return r2(top.reduce((a, n) => a + n.e.dur, 0) / 1000);
  };
  const threads = {
    mainBusyMs: r2(busy),
    mainUtilPct: r2((100 * busy) / windowMs),
    compositorBusyMs: threadBusy(ids.pid, ids.compositor),
    ioBusyMs: ids.io ? threadBusy(ids.pid, ids.io) : 0,
    workerBusyMs: r2(ids.workers.reduce((a, tid) => a + threadBusy(ids.pid, tid), 0)),
    vizBusyMs: ids.viz ? threadBusy(ids.gpuPid, ids.viz) : 0,
  };

  // ── JavaScript by function (sampled) ──
  const profile = cpuProfile(ev, ids.pid, ids.main, T.startTs, t1);
  const workerProfiles = ids.workers.map((tid) => ({ thread: threadName.get(`${ids.pid}:${tid}`), ...cpuProfile(ev, ids.pid, tid, T.startTs, t1) })).filter((p) => p.samples > 20);

  // ── backend ──
  const be = ids.backendPid ? ev.filter((e) => e.pid === ids.backendPid && e.ph !== "M") : [];
  const backend = {
    queries: be.filter((e) => e.ph === "X" && e.name.startsWith("query #") && inWin(e.ts)).length,
    queryWaitMs: quantiles(be.filter((e) => e.ph === "X" && e.name.startsWith("query #") && inWin(e.ts)).map((e) => e.args.waitedMs)),
    queueMax: Math.max(0, ...be.filter((e) => e.ph === "C" && e.name.startsWith("rows queue") && inWin(e.ts)).map((e) => e.args.value)),
    socketBufferedMaxKb: r2(Math.max(0, ...be.filter((e) => e.ph === "C" && e.name.startsWith("ticks socket") && inWin(e.ts)).map((e) => e.args.value)) / 1024),
    netemQueuedMaxKb: r2(Math.max(0, ...be.filter((e) => e.ph === "C" && e.name.startsWith("netem queued") && inWin(e.ts)).map((e) => e.args.value)) / 1024),
  };

  const metrics = {
    windowMs: r2(windowMs),
    frames: frameStats,
    main: {
      tasks: tasks.length, longTasks: longTasks.length, maxTaskMs: r2(Math.max(0, ...tasks) / 1000), longTaskMs: r2(longTasks.reduce((a, b) => a + b, 0) / 1000),
      scriptMs: r2(cat.script / 1000), gcMs: r2(cat.gc / 1000), styleMs: r2(cat.style / 1000), layoutMs: r2(cat.layout / 1000), paintMs: r2(cat.paint / 1000), commitMs: r2(cat.commit / 1000), otherMs: r2(cat.other / 1000),
      ...counts, forcedMs: r2(counts.forcedMs),
    },
    threads, app: appStats, marks: markCounts, eventLatency, content, ws, ticks, gc, raster, heap, backend,
    taskQueues: Object.fromEntries([...taskQueues].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => [k, { n: v.n, ms: r2(v.ms) }])),
  };

  // ── lanes for the charts ──
  const lanes = { main: mainLane };
  for (const [lane, spec] of Object.entries(LANES)) {
    const tid = ids[spec.thread];
    const pid = spec.thread === "browserMain" ? ids.browserPid : spec.thread === "viz" ? ids.gpuPid : ids.pid;
    lanes[lane] = ev
      .filter((e) => e.ph === "X" && e.pid === pid && e.tid === tid && e.name in spec.names && inLanes(e) && e.dur >= (spec.min ?? 20))
      .map((e) => [ms(e.ts), r3(e.dur / 1000), spec.names[e.name], e.name]);
  }
  lanes.tasks = mainEvents.filter((e) => e.ph === "X" && e.name === "RunTask" && inLanes(e) && e.dur >= 1000).map((e) => [ms(e.ts), r3(e.dur / 1000), e.dur >= 50_000 ? "longtask" : "task", "Task"]);
  lanes.gc = gcMain.filter(inLanes).map((e) => [ms(e.ts), r3(e.dur / 1000), "gc", `${e.name} (${r2((e.args?.usedHeapSizeBefore ?? 0) / 1e6)} → ${r2((e.args?.usedHeapSizeAfter ?? 0) / 1e6)} MB)`]);
  lanes.raster = rasterEv.filter(inLanes).map((e) => [ms(e.ts), r3(e.dur / 1000), "raster", "RasterTask"]);
  lanes.app = app.filter((a) => a.tid === ids.main || !ids.workers.includes(a.tid)).filter(inLanes).map((a) => [ms(a.ts), r3(a.dur / 1000), a.name, a.full + (Object.keys(a.d).length ? " " + JSON.stringify(a.d) : "")]);
  lanes.marks = marks.filter(inLanes).map((m) => [ms(m.ts), m.name, m.full]);
  lanes.worker = ids.workers.flatMap((tid) =>
    ev.filter((e) => e.ph === "X" && e.pid === ids.pid && e.tid === tid && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && inLanes(e) && e.dur >= 50).map((e) => [ms(e.ts), r3(e.dur / 1000), "js", "worker task"]),
  );
  lanes.io = ids.io ? ev.filter((e) => e.ph === "X" && onThread(e, ids.io) && e.name === "ThreadControllerImpl::RunTask" && inLanes(e) && e.dur >= 30).map((e) => [ms(e.ts), r3(e.dur / 1000), "io", e.args?.src_func ?? "task"]) : [];
  // One box per vsync: [start ms, state, sequence, scroll state, missing content, ms until presented]
  lanes.frames = vsync.map((f) => [ms(f.ts), f.state, f.seq, f.scroll, f.missing || f.checker ? 1 : 0, f.presentedAt ? r2((f.presentedAt - f.ts) / 1000) : null]);
  lanes.mainFrames = allFrames.filter((f) => f.main && f.main[1] >= lanesFrom && f.main[0] <= t1).map((f) => [ms(f.main[0]), r3((f.main[1] - f.main[0]) / 1000), f.state, f.seq, f.mainQueueUs != null ? r3(f.mainQueueUs / 1000) : null]);
  lanes.inputs = inputs.filter((e) => inLanes(e) && !/MouseMove/.test(e.name)).map((e) => [ms(e.ts), e.name.replace("InputLatency::", "")]);
  for (const [name, tid] of [["backendIo", 1], ["backendQuery", 2], ["backendTicks", 3], ["netem", 4], ["psp", 5]]) {
    lanes[name] = be.filter((e) => e.tid === tid && (e.ph === "X" || e.ph === "i") && inLanes(e)).map((e) => [ms(e.ts), e.ph === "X" ? r3(e.dur / 1000) : 0, e.ph === "X" ? "backend" : "instant", e.name]);
  }
  lanes.counters = {};
  for (const e of be) {
    if (e.ph !== "C" || !inLanes(e)) continue;
    (lanes.counters[e.name.replace(/ \(conn \d+\)/, "")] ??= []).push([ms(e.ts), e.args.value]);
  }
  // Thin out dense lanes so the page data stays small: keep the longest per bucket.
  const cap = (rows, max) => {
    if (rows.length <= max) return rows;
    const keep = [...rows].sort((a, b) => b[1] - a[1]).slice(0, max);
    return keep.sort((a, b) => a[0] - b[0]);
  };
  for (const k of Object.keys(lanes)) if (Array.isArray(lanes[k]) && k !== "marks" && k !== "inputs" && k !== "frames") lanes[k] = cap(lanes[k], 2500);
  lanes.marks = lanes.marks.length > 1500 ? lanes.marks.filter((_, i) => i % Math.ceil(lanes.marks.length / 1500) === 0) : lanes.marks;
  for (const k of Object.keys(lanes.counters)) {
    const rows = lanes.counters[k];
    if (rows.length > 600) lanes.counters[k] = rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0);
  }

  return { t0, endMs: ms(t1), startMs: ms(T.startTs), metrics, profile, workerProfiles, lanes };
}
