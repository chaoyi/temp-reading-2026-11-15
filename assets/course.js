// Shared behaviour of the course pages.
//
// A page is a list of <section class="step"> elements. This script adds the
// navigation, the side rail (where we are, open questions, what is known so
// far), predictions, and the data-driven parts:
//
//   <b data-m="scenario-id/frames.partial">       a number read from data/index.js
//   <div class="lanes" data-lanes='{...}'>         a thread-lane chart from data/<id>.js
//   <table class="mtable" data-rows="id,id" data-cols="path|label,...">
//   <div class="bars" data-bars='{...}'>           a bar chart over scenarios
//   <div class="prof" data-prof="id" data-top="8"> top JavaScript functions by self time
//   <div class="tracelink" data-trace="id">        how to open the raw trace
//
// Numbers in bold that carry data-m, the charts and the tables are generated
// from the recorded traces and change if the traces are re-recorded; plain
// numbers in prose describe the recording made on the date the page states.

const INDEX = window.TRACE_INDEX ?? {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const RAW = "https://raw.githubusercontent.com/chaoyi/temp-reading-2026-11-15/main/";
const base = document.currentScript?.src.replace(/assets\/course\.js.*$/, "") ?? "";

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function fmt(v, unit) {
  if (v == null || Number.isNaN(v)) return "—";
  if (typeof v !== "number") return String(v);
  const a = Math.abs(v);
  const s = Number.isInteger(v) ? v.toLocaleString("en-US") : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}
/** "scenario/path" → value; "scenario/a.b / scenario2/c.d" is not supported: one value per element. */
function metric(ref) {
  const i = ref.indexOf("/");
  const id = ref.slice(0, i);
  const path = ref.slice(i + 1);
  const d = INDEX[id];
  if (!d) return undefined;
  return path.startsWith("state.") || path.startsWith("query.") || path === "traceBytes" ? get(d, path) : get(d.metrics, path);
}
for (const el of $$("[data-m]")) {
  const v = metric(el.dataset.m);
  el.textContent = fmt(v, el.dataset.unit);
  if (v === undefined) el.title = "no data for " + el.dataset.m;
}

// ── raw traces ───────────────────────────────────────────────────────────
for (const el of $$(".tracelink[data-trace]")) {
  const id = el.dataset.trace;
  const d = INDEX[id];
  const file = `traces/${id}.json.gz`;
  const size = d?.traceBytes ? ` (${(d.traceBytes / 1e6).toFixed(1)} MB)` : "";
  const note = el.innerHTML.trim();
  el.innerHTML =
    `<b>Trace</b> <code>${file}</code>${size} <a href="${base}${file}" download>download</a>` +
    `<a href="https://ui.perfetto.dev/#!/?url=${encodeURIComponent(RAW + file)}" target="_blank" rel="noopener">open in Perfetto</a>` +
    `<span class="how">DevTools: Performance panel → ⬆ Load profile → the downloaded file. ${d?.query ? "Scenario: <code>" + new URLSearchParams(d.query).toString().replace(/&amp;/g, "&") + "</code>" : ""}${note ? " · " + note : ""}</span>`;
}

// ── metric tables ────────────────────────────────────────────────────────
for (const t of $$("table.mtable[data-rows]:not(.runs)")) {
  const rows = t.dataset.rows.split(",").map((s) => s.trim());
  const cols = t.dataset.cols.split(",").map((c) => {
    const [path, label, unit] = c.trim().split("|");
    return { path, label: label ?? path, unit };
  });
  const names = (t.dataset.names ?? "").split(",").map((s) => s.trim());
  let html = `<tr><th>${t.dataset.head ?? "Scenario"}</th>${cols.map((c) => `<th>${c.label}${c.unit ? `<small>${c.unit}</small>` : ""}</th>`).join("")}</tr>`;
  const hi = (t.dataset.hi ?? "").split(",");
  rows.forEach((id, i) => {
    html += `<tr><td>${names[i] || id}</td>${cols.map((c) => `<td class="num${hi.includes(id + ":" + c.path) ? " hi" : ""}">${fmt(metric(id + "/" + c.path))}</td>`).join("")}</tr>`;
  });
  t.innerHTML = html;
}

// ── repeated runs: min / median / max of a metric over the runs of one scenario ──
// <table class="mtable runs" data-runs="f-variance" data-cols="main.scriptMs|script|ms,frames.partial|frames without main"></table>
for (const t of $$("table.runs[data-runs]")) {
  const runs = INDEX.__runs?.[t.dataset.runs] ?? [];
  const cols = t.dataset.cols.split(",").map((c) => {
    const [path, label, unit] = c.trim().split("|");
    return { path, label: label ?? path, unit };
  });
  let html = `<tr><th>${runs.length} runs of ${t.dataset.runs}</th><th>min</th><th>median</th><th>max</th><th>max ÷ min</th></tr>`;
  for (const c of cols) {
    const v = runs.map((m) => Number(get(m, c.path))).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) continue;
    html += `<tr><td>${c.label}${c.unit ? " (" + c.unit + ")" : ""}</td><td class="num">${fmt(v[0])}</td><td class="num">${fmt(v[v.length >> 1])}</td><td class="num">${fmt(v[v.length - 1])}</td><td class="num">${v[0] > 0 ? (v[v.length - 1] / v[0]).toFixed(2) + "×" : "—"}</td></tr>`;
  }
  t.innerHTML = html;
}

// ── bar charts over scenarios ────────────────────────────────────────────
// {"ids":[...], "labels":[...], "series":[{"path":"main.scriptMs","label":"script","color":"#d9a800"}], "unit":"ms", "stack":true, "title":"..."}
for (const el of $$(".bars[data-bars]")) {
  const spec = JSON.parse(el.dataset.bars);
  const W = 1000, L = 210, R = 70, RH = 20, GAP = 6;
  const vals = spec.ids.map((id) => spec.series.map((s) => Number(metric(id + "/" + s.path) ?? 0)));
  const total = (v) => (spec.stack ? v.reduce((a, b) => a + b, 0) : Math.max(...v));
  const max = Math.max(spec.max ?? 0, ...vals.map(total)) || 1;
  const x = (v) => (v / max) * (W - L - R);
  let y = 4, svg = "";
  spec.ids.forEach((id, i) => {
    const sub = spec.stack ? 1 : spec.series.length;
    svg += `<text x="${L - 8}" y="${y + (RH * sub) / 2 + 4}" font-size="12.5" text-anchor="end" fill="#171a20" font-family="monospace">${spec.labels?.[i] ?? id}</text>`;
    let off = 0;
    vals[i].forEach((v, k) => {
      const s = spec.series[k];
      const yy = spec.stack ? y : y + k * RH;
      svg += `<rect x="${L + (spec.stack ? x(off) : 0)}" y="${yy + 2}" width="${Math.max(v > 0 ? 1.5 : 0, x(v))}" height="${RH - 4}" fill="${s.color ?? "#3d6b8e"}"><title>${s.label}: ${fmt(v)} ${spec.unit ?? ""}</title></rect>`;
      if (!spec.stack) svg += `<text x="${L + x(v) + 5}" y="${yy + 14}" font-size="12" fill="#55606e" font-family="monospace">${fmt(v)}</text>`;
      off += v;
    });
    if (spec.stack) svg += `<text x="${L + x(off) + 5}" y="${y + 14}" font-size="12" fill="#55606e" font-family="monospace">${fmt(off)}</text>`;
    y += RH * sub + GAP;
  });
  if (spec.line != null) svg += `<line x1="${L + x(spec.line)}" x2="${L + x(spec.line)}" y1="0" y2="${y}" stroke="#d42a5b" stroke-dasharray="4 3"/><text x="${L + x(spec.line) + 4}" y="${y + 4}" font-size="11" fill="#b01c48" font-family="monospace">${spec.lineLabel ?? spec.line}</text>`;
  const key = spec.series.length > 1 || spec.stack ? `<div class="key">${spec.series.map((s) => `<span><i style="background:${s.color ?? "#3d6b8e"}"></i>${s.label}</span>`).join("")}</div>` : "";
  el.innerHTML = `<div class="cap">${spec.title ?? ""}${spec.unit ? ` (${spec.unit})` : ""}</div><svg viewBox="0 0 ${W} ${y + 10}" role="img">${svg}</svg>${key}`;
}

// ── top functions ────────────────────────────────────────────────────────
for (const el of $$(".prof[data-prof]")) {
  const d = INDEX[el.dataset.prof];
  const which = el.dataset.by === "total" ? "total" : "self";
  const rows = (d?.profile?.[which] ?? []).filter((r) => !(el.dataset.skip ?? "(program)").split(",").includes(r.fn)).slice(0, Number(el.dataset.top ?? 8));
  el.innerHTML = `<table><tr><th>Function (sampled, ${which} time) · <span style="font-weight:400">${el.dataset.prof}</span></th><th>ms</th></tr>${rows.map((r) => `<tr><td>${r.fn.replace(/</g, "&lt;")} <span class="at">${r.at}</span></td><td class="num">${fmt(r.ms)}</td></tr>`).join("")}</table>`;
}

// ── lane charts ──────────────────────────────────────────────────────────
// {"traces":["id",...], "from":ms, "to":ms, "rows":[...], "pins":[[n, ms, row, traceIndex]], "counters":["name"]}
const COLORS = {
  input: "#7d8794", scroll: "#2a78d6", draw: "#1baf7a", commit: "#8a63d2", frame: "#b9c3ce", longtask: "#d42a5b", task: "#c9d1d9",
  js: "#d9a800", layout: "#9b59d0", forced: "#d42a5b", paint: "#2e9e5b", gc: "#e0572f", raster: "#1baf7a", io: "#7d8794",
  backend: "#3d6b8e", instant: "#3d6b8e", all: "#1baf7a", partial: "#f2b134", dropped: "#d42a5b", none: "#dfe5ea",
  app: "#e08a3a",
};
const APPCOLOR = { "ws round trip": "#3d6b8e", "ws parse": "#6fa8dc", "long task": "#d42a5b", "background work": "#d42a5b", "tick apply": "#c0562b", "style listener": "#a05a14" };
const ROWLABEL = {
  inputs: "input events", browser: "browser main", compositor: "compositor thread", frames: "frames (per vsync)", mainFrames: "main frames", tasks: "main: tasks ≥ 1 ms",
  "main.js": "main: events, JS", "main.layout": "main: style, layout", "main.paint": "main: paint, commit", gc: "main: GC",
  app: "our code (elapsed)", marks: "our marks", worker: "worker thread", io: "renderer IO thread", raster: "raster workers", viz: "viz (GPU process)",
  backendIo: "backend: socket", backendQuery: "backend: query service", backendTicks: "backend: tick producer", netem: "netem proxy", psp: "backend: Perspective",
};
const MAINSUB = { "main.js": ["js"], "main.layout": ["layout", "forced"], "main.paint": ["paint", "commit"] };
const DEFAULT_ROWS = ["inputs", "compositor", "frames", "mainFrames", "main", "app"];
const loaded = new Map();
function loadTrace(id) {
  if (!loaded.has(id))
    loaded.set(
      id,
      new Promise((resolve) => {
        if (window.TRACE_DATA?.[id]) return resolve(window.TRACE_DATA[id]);
        const s = document.createElement("script");
        s.src = `${base}data/${id}.js`;
        s.onload = () => resolve(window.TRACE_DATA?.[id]);
        s.onerror = () => resolve(undefined);
        document.head.appendChild(s);
      }),
    );
  return loaded.get(id);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

async function lanes(el) {
  const spec = JSON.parse(el.dataset.lanes);
  const data = await Promise.all(spec.traces.map(loadTrace));
  const rows = (spec.rows ?? DEFAULT_ROWS).flatMap((r) => (r === "main" ? Object.keys(MAINSUB) : [r]));
  const W = 1000, L = 150, R = 12, RH = 18, GAP = 3, AX = 20;
  const from = spec.from ?? Math.min(...data.map((d) => d?.startMs ?? 0));
  const to = spec.to ?? Math.max(...data.map((d) => d?.endMs ?? 1000));
  const x = (t) => L + ((t - from) / (to - from)) * (W - L - R);
  const barsOf = (tr, row) => (MAINSUB[row] ? (tr?.lanes.main ?? []).filter(([, , k]) => MAINSUB[row].includes(k)) : (tr?.lanes[row] ?? []));
  let svg = "", y = 4;
  const rowY = [];
  data.forEach((tr, ti) => {
    rowY[ti] = {};
    const title = spec.titles?.[ti] ?? spec.traces[ti];
    svg += `<text x="0" y="${y + 13}" font-size="13" font-weight="700">${esc(title)}</text>`;
    y += 20;
    if (!tr) {
      svg += `<text x="${L}" y="${y + 13}" font-size="12" fill="#b01c48">no data for ${esc(spec.traces[ti])}</text>`;
      y += 24;
      return;
    }
    rows.forEach((row, ri) => {
      rowY[ti][row] = y;
      if (ri % 2 === 0) svg += `<rect x="${L}" y="${y}" width="${W - L - R}" height="${RH}" fill="#f6f8fa"/>`;
      svg += `<text x="${L - 8}" y="${y + 13}" font-size="12" fill="#55606e" text-anchor="end">${ROWLABEL[row] ?? row}</text>`;
      if (row === "frames") {
        // One box per vsync, coloured by what was presented for it.
        const fr = tr.lanes.frames ?? [];
        const w = Math.max(1.5, x(from + 16.67) - x(from) - 0.8); // one vsync interval wide
        for (const [t, state, seq, scroll, missing, presented] of fr) {
          if (t < from - 17 || t > to) continue;
          svg += `<rect x="${Math.max(L, x(t))}" y="${y + 2}" width="${Math.max(1.5, Math.min(w, W - R - Math.max(L, x(t))))}" height="${RH - 4}" fill="${COLORS[state]}"${missing ? ' stroke="#171a20" stroke-width="1.5"' : ""}><title>vsync ${seq} at ${t.toFixed(1)} ms: ${{ all: "presented with the main thread's update", partial: "presented without the main thread's pending update", dropped: "dropped", none: "no update wanted" }[state]}${scroll ? " · " + scroll : ""}${missing ? " · missing content" : ""}${presented != null ? ` · presented ${presented} ms after its vsync` : ""}</title></rect>`;
        }
      } else if (row === "inputs") {
        for (const [t, name] of tr.lanes.inputs ?? []) if (t >= from && t <= to) svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${y + 2}" y2="${y + RH - 2}" stroke="${/Gesture/.test(name) ? "#2a78d6" : "#171a20"}" stroke-width="1.5"><title>${esc(name)} — ${t.toFixed(1)} ms</title></line>`;
      } else if (row === "marks") {
        for (const [t, name, full] of tr.lanes.marks ?? []) if (t >= from && t <= to) svg += markGlyph(name, full, x(t), y, RH, t);
      } else {
        for (const b of barsOf(tr, row)) {
          const [t, d, kind, label] = b;
          if (t + d < from || t > to) continue;
          const x0 = Math.max(x(t), L), x1 = Math.min(x(t + d), W - R);
          const color = row === "app" ? (APPCOLOR[kind] ?? COLORS.app) : row === "mainFrames" ? COLORS[kind] ?? COLORS.frame : (COLORS[kind] ?? "#999");
          const extra = row === "mainFrames" && b[4] != null ? ` · waited ${b[4]} ms for the main thread` : "";
          svg += `<rect x="${x0}" y="${y + 2}" width="${Math.max(1.5, x1 - x0)}" height="${RH - 4}" fill="${color}" rx="1"><title>${esc(row === "mainFrames" ? `main frame for vsync ${label}` : label)} — at ${t.toFixed(2)} ms, ${d.toFixed(2)} ms${extra}</title></rect>`;
        }
        if (row === "app") for (const [t, name, full] of tr.lanes.marks ?? []) if (t >= from && t <= to && (name === "content complete" || name === "ws request")) svg += markGlyph(name, full, x(t), y, RH, t);
      }
      y += RH + GAP;
    });
    // Counter series (backend queue lengths, buffered bytes) as small line charts.
    for (const name of spec.counters ?? []) {
      const pts = tr.lanes.counters?.[name] ?? [];
      const H = 44;
      const max = Math.max(1, ...pts.map((p) => p[1]));
      svg += `<rect x="${L}" y="${y}" width="${W - L - R}" height="${H}" fill="#f6f8fa"/><text x="${L - 8}" y="${y + 14}" font-size="12" fill="#55606e" text-anchor="end">${esc(name.replace("netem ", "").replace("ticks ", "")).slice(0, 22)}</text><text x="${L - 8}" y="${y + 30}" font-size="11" fill="#898781" text-anchor="end">max ${fmt(max)}</text>`;
      let dpath = "";
      for (const [t, v] of pts) {
        if (t < from || t > to) continue;
        const py = y + H - 2 - (v / max) * (H - 6);
        dpath += dpath ? ` H${x(t)} V${py}` : `M${x(Math.max(t, from))} ${py}`;
      }
      if (dpath) svg += `<path d="${dpath} H${W - R}" fill="none" stroke="#3d6b8e" stroke-width="1.5"/>`;
      y += H + GAP;
    }
    y += 10;
  });
  if (0 >= from && 0 <= to) svg += `<line x1="${x(0)}" x2="${x(0)}" y1="0" y2="${y}" stroke="#d42a5b" stroke-dasharray="4 3"/>`;
  const span = to - from, steps = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const step = steps.find((s) => span / s <= 12) ?? 2000;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step)
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${y}" y2="${y + 5}" stroke="#55606e"/><text x="${x(t)}" y="${y + AX - 3}" font-size="12" text-anchor="middle" fill="#55606e">${+t.toFixed(1)}</text>`;
  svg += `<text x="${W - R}" y="${y + AX + 12}" font-size="11" text-anchor="end" fill="#898781">${spec.axis ?? "ms after the first input (dashed), or after the start mark"}</text>`;
  for (const [n, t, row, ti = 0] of spec.pins ?? []) {
    let r = row;
    if (row === "main") {
      const subs = Object.keys(MAINSUB);
      const hit = (tol) => subs.find((sub) => barsOf(data[ti], sub).some(([b, d]) => b <= t + tol && b + d >= t - tol));
      r = hit(0) ?? hit(span / 400) ?? "main.js";
    }
    const py = rowY[ti]?.[r];
    if (py === undefined) continue;
    const tx = x(t), cy = py + RH / 2, left = tx - 24 >= L;
    const cx = left ? tx - 15 : tx + 15;
    svg += `<line x1="${left ? cx + 9 : cx - 9}" x2="${tx}" y1="${cy}" y2="${cy}" stroke="#d42a5b" stroke-width="2"/><path d="M${tx} ${cy} l${left ? -5 : 5} -4 l0 8z" fill="#d42a5b"/><circle cx="${cx}" cy="${cy}" r="9" fill="#d42a5b" stroke="#fff" stroke-width="2"/><text x="${cx}" y="${cy + 4}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">${n}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${y + AX + 16}" role="img" aria-label="thread lanes">${svg}</svg>`;
  const used = new Set(rows);
  const key = [];
  if (used.has("frames") || used.has("mainFrames")) key.push(["all", "frame with main update"], ["partial", "frame without the pending main update"], ["dropped", "dropped"], ["none", "no update wanted"]);
  if (used.has("compositor")) key.push(["input", "input"], ["scroll", "scroll"], ["draw", "draw"], ["commit", "commit / activate"]);
  if (used.has("main.js")) key.push(["js", "events, JS"], ["layout", "style, layout"], ["forced", "forced by JS"], ["paint", "paint"]);
  if (used.has("gc")) key.push(["gc", "GC"]);
  if (used.has("tasks")) key.push(["task", "task"], ["longtask", "task ≥ 50 ms"]);
  if (used.has("app")) key.push(["app", "our measures"]);
  if ([...used].some((r) => r.startsWith("backend") || r === "psp" || r === "netem")) key.push(["backend", "backend span"]);
  if (!el.nextElementSibling?.classList.contains("key"))
    el.insertAdjacentHTML("afterend", `<div class="key">${key.map(([k, label]) => `<span><i style="background:${COLORS[k]}"></i>${label}</span>`).join("")}<span>◆ right rows in the DOM · ┃ request sent · hover a bar for its name and times</span></div>`);
}
function markGlyph(name, full, px, y, RH, t) {
  if (name === "content complete") return `<path d="M${px} ${y + 2} l5 7 l-5 7 l-5 -7z" fill="#1b8a62" stroke="#fff" stroke-width="1"><title>right rows in the DOM — ${t.toFixed(1)} ms</title></path>`;
  if (name === "ws request") return `<line x1="${px}" x2="${px}" y1="${y}" y2="${y + RH}" stroke="#3d6b8e" stroke-width="2"><title>${esc(full)} — ${t.toFixed(1)} ms</title></line>`;
  return `<line x1="${px}" x2="${px}" y1="${y + 3}" y2="${y + RH - 3}" stroke="#a05a14" stroke-width="1"><title>${esc(full)} — ${t.toFixed(1)} ms</title></line>`;
}
// Charts are drawn when their step is first shown (each loads its trace data).
const drawn = new WeakSet();
function drawLanes(scope) {
  for (const el of $$(".lanes[data-lanes]", scope)) {
    if (drawn.has(el)) continue;
    drawn.add(el);
    lanes(el);
  }
}

// ── predictions ──────────────────────────────────────────────────────────
for (const p of $$(".predict"))
  for (const b of $$(".opts button", p))
    b.addEventListener("click", () => {
      if (p.classList.contains("answered")) return;
      p.classList.add("answered");
      b.classList.add("picked");
      $(`.opts button[data-k="${p.dataset.right}"]`, p)?.classList.add("right");
      renderRail();
    });

// ── lightbox ─────────────────────────────────────────────────────────────
let lb = $("#lightbox");
if (!lb) {
  lb = document.createElement("div");
  lb.id = "lightbox";
  lb.className = "lightbox";
  document.body.appendChild(lb);
}
for (const f of $$(".frame"))
  f.addEventListener("click", () => {
    const img = $("img", f);
    const cap = f.closest("figure")?.querySelector("figcaption");
    lb.innerHTML = `<div class="lbwrap" style="width:${Math.max(img.naturalWidth, 900)}px"><div class="frame">${f.innerHTML}</div>${cap ? `<div class="lbcap">${cap.innerHTML}</div>` : ""}</div>`;
    lb.classList.add("on");
  });
lb.addEventListener("click", () => lb.classList.remove("on"));

// ── navigation, step map, pipeline, ledger, questions ────────────────────
const steps = $$(".step");
const KIND = { read: "read in source", measured: "measured", inferred: "inferred", rejected: "rejected" };
const dots = $("#dots"), map = $("#map");
let cur = -1;
if (steps.length && dots) {
  let lastPart = null, partList = null;
  steps.forEach((s, i) => {
    const part = s.dataset.part;
    const b = document.createElement("button");
    b.title = `${i + 1}. ${s.dataset.title}`;
    if (part !== lastPart && i) b.classList.add("partstart");
    b.onclick = () => go(i);
    dots.appendChild(b);
    if (part !== lastPart) {
      const li = document.createElement("li");
      li.textContent = part;
      partList = document.createElement("ol");
      partList.start = i + 1;
      li.appendChild(partList);
      map.appendChild(li);
      lastPart = part;
    }
    const item = document.createElement("li");
    item.textContent = s.dataset.title;
    item.onclick = () => go(i);
    partList.appendChild(item);
    const inPart = steps.filter((x) => x.dataset.part === part);
    s.insertAdjacentHTML("afterbegin", `<p class="kicker">Step ${i + 1} of ${steps.length} · ${part} · ${inPart.indexOf(s) + 1} of ${inPart.length}</p><h2>${s.dataset.title}</h2>`);
    if (!$(".foot", s)) s.insertAdjacentHTML("beforeend", `<div class="foot"><button class="prevb">← Back</button><button class="primary nextb">${i + 1 < steps.length ? "Next →" : "Back to the course map"}</button></div>`);
    $(".prevb", s).onclick = () => go(cur - 1);
    $(".nextb", s).onclick = () => (cur + 1 < steps.length ? go(cur + 1) : (location.href = base + "index.html"));
  });
}
const mapItems = $$("#map ol li");
const held = (s) => {
  const p = $(".predict", s);
  return p && p.dataset.right !== "x" && !p.classList.contains("answered") && !document.body.classList.contains("all");
};
function render() {
  steps.forEach((s, k) => s.classList.toggle("on", k === cur));
  $$("button", dots).forEach((b, k) => {
    b.classList.toggle("done", k < cur);
    if (k === cur) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
  mapItems.forEach((li, k) => {
    li.classList.toggle("current", k === cur);
    li.classList.toggle("done", k < cur);
  });
  $("#count").textContent = cur < 0 ? "intro" : `${cur + 1} / ${steps.length}`;
  const nodes = cur < 0 ? [] : (steps[cur].dataset.node ?? "").split(" ");
  $$("#pipe span[data-node]").forEach((n) => n.classList.toggle("on", nodes.includes(n.dataset.node)));
  renderRail();
  if (document.body.classList.contains("all")) drawLanes(document);
  else if (cur >= 0) drawLanes(steps[cur]);
  else drawLanes($("#intro") ?? document.body);
  if (!document.body.classList.contains("all")) window.scrollTo({ top: 0 });
  history.replaceState(null, "", cur < 0 ? location.pathname + location.search : `#${cur + 1}`);
}
function renderRail() {
  const ledger = $("#ledger");
  if (!ledger) return;
  ledger.innerHTML = "";
  let shown = 0, waiting = 0;
  for (let k = 0; k <= cur; k++) {
    const items = $$("ul.add li", steps[k]);
    if (k === cur && held(steps[k])) {
      waiting = items.length;
      continue;
    }
    shown += items.length;
    items.forEach((li) => ledger.insertAdjacentHTML("afterbegin", `<li class="${li.dataset.kind}${k === cur ? " new" : ""}"><span class="kind">${KIND[li.dataset.kind]} · step ${k + 1}</span>${li.innerHTML}</li>`));
  }
  if (waiting) ledger.insertAdjacentHTML("afterbegin", `<li class="held"><span class="kind">step ${cur + 1}</span>Answer the prediction to add this step's ${waiting === 1 ? "finding" : `${waiting} findings`}.</li>`);
  $("#ledger-count").textContent = shown ? `(${shown}, newest first)` : "";
  if (!ledger.children.length) ledger.innerHTML = `<li><span class="kind">empty</span>Nothing established yet.</li>`;
  const asks = $("#asks");
  asks.innerHTML = "";
  const qs = new Map();
  for (let k = 0; k <= cur; k++) {
    const s = steps[k];
    if (s.dataset.ask) {
      const [id, text] = s.dataset.ask.split("|");
      qs.set(id, { text, opened: k + 1 });
    }
    const ans = $("[data-answer]", s)?.dataset.answer;
    if (ans && qs.has(ans)) qs.get(ans).closed = k + 1;
  }
  const here = cur + 1;
  const state = (id, q) => (id === "standing" ? 0 : !q.closed || q.closed === here ? 1 : 2);
  const label = (id, q) =>
    id === "standing" ? "standing question" : q.closed === here ? (q.opened === here ? "this step answers it" : `open since step ${q.opened} · answered here`) : q.closed ? `answered by step ${q.closed}` : q.opened === here ? "opened here" : `open since step ${q.opened}`;
  const item = ([id, q]) => `<li class="${["standing", "", "closed"][state(id, q)]}"><span class="kind">${label(id, q)}</span>${q.text}</li>`;
  const all = [...qs].sort(([a, qa], [b, qb]) => state(a, qa) - state(b, qb) || (qb.closed ?? 0) - (qa.closed ?? 0));
  const done = all.filter(([id, q]) => state(id, q) === 2);
  asks.innerHTML = all.filter(([id, q]) => state(id, q) < 2).map(item).join("") + (done.length ? `<li class="group"><details><summary>${done.length} answered</summary><ul class="asks">${done.map(item).join("")}</ul></details></li>` : "");
  if (!asks.children.length) asks.innerHTML = `<li class="standing"><span class="kind">standing question</span>Faced with any trace: what is my question, what is one unit of work, where is the unexplained time, and is it work or waiting?</li>`;
}
function go(i) {
  cur = Math.max(-1, Math.min(steps.length - 1, i));
  lb.classList.remove("on");
  document.body.classList.toggle("started", cur >= 0);
  render();
}
if (steps.length && dots) {
  $("#prev").onclick = () => go(cur - 1);
  $("#next").onclick = () => go(cur + 1);
  $("#all").onclick = () => {
    document.body.classList.toggle("all");
    renderRail();
    drawLanes(document);
  };
  for (const b of $$("[data-start]")) b.onclick = () => go(0);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "ArrowRight") go(cur + 1);
    if (e.key === "ArrowLeft") go(cur - 1);
    if (e.key === "Escape") lb.classList.remove("on");
  });
  const fromHash = () => go((parseInt(location.hash.slice(1)) || 0) - 1);
  window.addEventListener("hashchange", fromHash);
  fromHash();
} else drawLanes(document);
