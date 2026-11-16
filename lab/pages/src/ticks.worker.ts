// apply=worker: the tick socket lives here. Messages are parsed and conflated
// (latest value per cell) off the main thread; the page pulls the dirty cells
// once per frame and gets them as one transferred Float64Array.

import { decode } from "./ticks";

const dirty = new Map<number, [number, number, number]>();
let seq = 0;
let oldest = 0;
let newest = 0;
let messages = 0;
let bytes = 0;
let socket: WebSocket | undefined;

self.onmessage = (ev: MessageEvent<{ url?: string; pull?: boolean; control?: object }>) => {
  if (ev.data.url) {
    socket = new WebSocket(ev.data.url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (m: MessageEvent<string | ArrayBuffer>) => {
      const d = decode(m.data);
      messages++;
      bytes += typeof m.data === "string" ? m.data.length : m.data.byteLength;
      seq = d.s;
      for (const u of d.u) dirty.set(u[0] * 4096 + u[1], u);
      if (!oldest) oldest = d.f;
      newest = d.t;
    };
  } else if (ev.data.control) socket?.send(JSON.stringify(ev.data.control));
  else if (ev.data.pull) {
    const cells = new Float64Array(dirty.size * 3);
    let i = 0;
    for (const u of dirty.values()) {
      cells[i++] = u[0];
      cells[i++] = u[1];
      cells[i++] = u[2];
    }
    dirty.clear();
    (self as unknown as Worker).postMessage({ seq, oldestUs: oldest, newestUs: newest, messages, bytes, cells }, [cells.buffer]);
    oldest = 0;
    messages = 0;
    bytes = 0;
  }
};
