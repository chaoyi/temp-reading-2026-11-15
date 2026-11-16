#!/usr/bin/env node
// The lab server, one process:
//   - serves the built lab pages (dist/, from `npm run build`) and the built
//     upstream examples (upstream/dist/) with cross-origin isolation headers,
//     so performance.now() has 5 µs resolution;
//   - the WebSocket backend (backend.mjs) and, on request, a Perspective
//     server (psp.mjs);
//   - a netem proxy port in front of the same server (netem.mjs);
//   - control endpoints for the harness:
//       GET  /__env.js    the ports, as a script the pages load
//       GET  /__spans     drain the backend's trace events (JSON)
//       POST /__netem     set the bad-network parameters (JSON body)
//       GET  /__psp       set the Perspective server's update rate (--psp)
//
//   node server/main.mjs [--port 5199]

import http from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { attachBackend } from "./backend.mjs";
import { netem, startNetem } from "./netem.mjs";
import { drain } from "./spans.mjs";

const arg = (name, d) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = Number(arg("port", 5199));
const host = "127.0.0.1";

const httpServer = http.createServer();
// Static roots: the built lab pages, and the built upstream examples.
const RT_DIST = fileURLToPath(new URL("../node_modules/regular-table/dist/", import.meta.url));
const ROOTS = [
  // regular-table's examples load the library as /dist/… or ../dist/…: the published build.
  ["/upstream/regular-table/dist/", RT_DIST],
  ["/dist/", RT_DIST],
  ["/upstream/", fileURLToPath(new URL("../upstream/dist/", import.meta.url))],
  ["/", fileURLToPath(new URL("../dist/", import.meta.url))],
];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".arrow": "application/octet-stream" };
function serveStatic(pathname, res) {
  for (const [prefix, dir] of ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    let file = normalize(join(dir, decodeURIComponent(pathname.slice(prefix.length))));
    if (!file.startsWith(dir)) break;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) continue;
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    return void res.end(readFileSync(file));
  }
  res.statusCode = 404;
  res.end("not found: " + pathname);
}

let env = {};
const body = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c)).on("end", () => resolve(s ? JSON.parse(s) : {}));
  });
httpServer.on("request", async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Cross-origin isolation: 5 µs timers, SharedArrayBuffer.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (url.pathname === "/__env.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(`window.__LAB_ENV = ${JSON.stringify(env)};`);
  }
  if (url.pathname === "/__spans") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(drain()));
  }
  if (url.pathname === "/__psp") {
    // Set the Perspective server's update stream: /__psp?hz=100&n=1&span=12
    psp?.setRate({ hz: Number(url.searchParams.get("hz") ?? 0), n: Number(url.searchParams.get("n") ?? 1), span: Number(url.searchParams.get("span") ?? 12) });
    return res.end(psp ? "ok" : "no perspective server (start with --psp)");
  }
  if (url.pathname === "/__netem") {
    if (req.method === "POST") Object.assign(netem, { latencyMs: 0, jitterMs: 0, kbps: 0, stallAtMs: -1, stallMs: 0, everyMs: 0 }, await body(req));
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(netem));
  }
  serveStatic(url.pathname, res);
});

const extra = {};
let psp;
if (process.argv.includes("--psp")) {
  const { perspectiveRoute } = await import("./psp.mjs");
  psp = extra["/ws/psp"] = await perspectiveRoute();
}
attachBackend(httpServer, { extra });
await new Promise((r) => httpServer.listen(port, host, r));
const actual = httpServer.address().port;
const proxy = await startNetem(actual, host);
env = { port: actual, netemPort: proxy.port, pid: process.pid };
console.log(JSON.stringify({ ready: true, origin: `http://${host}:${actual}`, ...env }));

const stop = async () => {
  proxy.close();
  httpServer.close();
  process.exit(0);
};
process.on("SIGTERM", stop).on("SIGINT", stop);
