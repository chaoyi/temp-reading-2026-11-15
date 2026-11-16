// A bad network between the page and the backend, in user space.
//
// A TCP proxy: the page connects to the proxy's port instead of the
// backend's, and every chunk of bytes, in both directions, is held back by
//   - latencyMs (± jitterMs) of one-way delay,
//   - a bandwidth limit of kbps (bytes leave no faster than that),
//   - stalls: from stallAtMs after the connection opened, nothing passes for
//     stallMs; then everything queued leaves at once (a radio handover, a
//     congested hop, a suspended laptop).
// Order is preserved, as TCP preserves it: a chunk never overtakes an
// earlier one, so one late chunk delays everything behind it (head-of-line
// blocking). When more than HIGH_WATER bytes are queued in one direction the
// proxy stops reading from the sender, which is how TCP's own flow control
// pushes back: the sender's socket buffer fills and its writes queue up.
//
// This shapes delay and throughput. It does not model loss, retransmission
// or congestion-window dynamics; `tc netem` (root) does that.

import net from "node:net";
import { counter, instant, nowUs } from "./spans.mjs";

const HIGH_WATER = 256 * 1024;

export const netem = { latencyMs: 0, jitterMs: 0, kbps: 0, stallAtMs: -1, stallMs: 0, everyMs: 0 };

export function startNetem(targetPort, host = "127.0.0.1") {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, host);
    const opened = performance.now();
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream, "up", opened);
    pipe(upstream, client, "down", opened);
    const close = () => (client.destroy(), upstream.destroy());
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({ port: server.address().port, close: () => server.close() })));
}

function pipe(from, to, dir, opened) {
  let lastRelease = 0; // performance.now() ms at which the previous chunk leaves
  let queued = 0;
  let stalled = false;
  from.on("data", (chunk) => {
    const now = performance.now();
    const c = netem;
    let at = now + c.latencyMs + (c.jitterMs ? (Math.random() * 2 - 1) * c.jitterMs : 0);
    if (c.kbps) at = Math.max(at, lastRelease + (chunk.length * 8) / c.kbps); // ms to send these bytes
    // A stall window, once (stallAtMs) or repeating (everyMs).
    if (c.stallMs > 0 && c.stallAtMs >= 0) {
      const since = at - opened - c.stallAtMs;
      const phase = c.everyMs > 0 && since >= 0 ? since % c.everyMs : since;
      if (phase >= 0 && phase < c.stallMs) {
        at += c.stallMs - phase;
        if (!stalled) instant("netem", `stall ${dir} ${c.stallMs} ms`, nowUs());
        stalled = true;
      } else stalled = false;
    }
    at = Math.max(at, lastRelease); // never reorder
    lastRelease = at;
    queued += chunk.length;
    if (queued > HIGH_WATER) from.pause();
    if (dir === "down") counter("netem queued bytes (to page)", queued);
    setTimeout(() => {
      queued -= chunk.length;
      if (!to.destroyed) to.write(chunk);
      if (queued <= HIGH_WATER / 2 && from.isPaused()) from.resume();
      if (dir === "down") counter("netem queued bytes (to page)", queued);
    }, Math.max(0, at - now));
  });
}
