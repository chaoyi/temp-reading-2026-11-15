// Launching Chrome, the lab server, and recording one trace over the DevTools
// protocol. Used by record.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const LAB = fileURLToPath(new URL("..", import.meta.url));
export const CHROME = process.env.BROWSER_PATH || "/usr/bin/google-chrome-stable";

/** The categories every trace records. `more` adds scenario-specific ones. */
export const CATEGORIES = [
  "devtools.timeline", // what DevTools' Performance panel draws: tasks, events, style, layout, paint, GC
  "disabled-by-default-devtools.timeline", // + Paint/Layerize detail, UpdateLayer
  "disabled-by-default-devtools.timeline.frame", // BeginFrame, DrawFrame, DroppedFrame: the Frames track
  "blink.user_timing", // performance.mark / measure
  "v8.execute",
  "v8", // GC phases, compile
  "disabled-by-default-v8.cpu_profiler", // sampled JavaScript stacks
  "disabled-by-default-v8.cpu_profiler.hires", // … every ~0.1 ms instead of 1 ms
  "input", // input events through browser, compositor and main
  "latencyInfo", // InputLatency::* async events
  "benchmark", // PipelineReporter (one per frame, with its outcome), EventLatency
  "cc", // the compositor: scheduler, commits, draws, tiles
  "viz", // the display compositor in the GPU process
  "gpu",
  "blink", // rendering lifecycle internals
  "scheduler", // queue name, priority and task type on every task
  "renderer.scheduler", // the main-thread scheduler's policy decisions
  "disabled-by-default-renderer.scheduler",
  "toplevel", // every task on every thread
  "toplevel.flow", // arrows from where a task was posted to where it ran
  "loading",
  "devtools.timeline.async",
];

export async function startServer({ psp = false } = {}) {
  const args = [LAB + "server/main.mjs", "--port", "0"];
  if (psp) args.push("--psp");
  const proc = spawn("node", args, { cwd: LAB, stdio: ["ignore", "pipe", "inherit"] });
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) if (line.includes('"ready"')) resolve(JSON.parse(line));
    });
    proc.on("exit", (code) => reject(new Error("lab server exited: " + code)));
  });
  return {
    ...info,
    spans: async () => (await fetch(info.origin + "/__spans")).json(),
    netem: async (cfg) => (await fetch(info.origin + "/__netem", { method: "POST", body: JSON.stringify(cfg ?? {}) })).json(),
    stop: () => proc.kill("SIGTERM"),
  };
}

export async function launch({ headed = false } = {}) {
  return chromium.launch({
    executablePath: CHROME,
    headless: !headed,
    ignoreDefaultArgs: ["--hide-scrollbars"], // so the scrollbar can be clicked and dragged
    args: ["--enable-precise-memory-info", "--force-color-profile=srgb"],
  });
}

/** Start tracing on the whole browser; returns stop() → the parsed trace object. */
export async function startTrace(browser, { screenshots = false, more = [], only = null, bufferMb = 600 } = {}) {
  const cdp = await browser.newBrowserCDPSession();
  const includedCategories = only ? [...only] : [...CATEGORIES, ...more];
  if (screenshots) includedCategories.push("disabled-by-default-devtools.screenshot");
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: bufferMb * 1024, includedCategories },
  });
  return async function stop() {
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const { stream, dataLossOccurred } = await done;
    const chunks = [];
    for (;;) {
      const { data, eof, base64Encoded } = await cdp.send("IO.read", { handle: stream, size: 16 * 1024 * 1024 });
      chunks.push(base64Encoded ? Buffer.from(data, "base64") : Buffer.from(data, "utf8"));
      if (eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await cdp.detach();
    const trace = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { trace: Array.isArray(trace) ? { traceEvents: trace } : trace, dataLossOccurred, categories: includedCategories };
  };
}
