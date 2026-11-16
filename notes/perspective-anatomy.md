# Perspective v5.9.2 anatomy — how the datagrid puts rows on screen

Scope: `perspective-dev/perspective` at tag `v5.9.2` (commit `0264ec13`), read from
`<checkout>/perspective`; `regular-table` at tag `v0.9.2`
(commit `52e86bf`), read from `~/src/repos/regular-table`. Published npm tarballs
(`@perspective-dev/{client,viewer,viewer-datagrid,server}@5.9.2`) were downloaded with
`npm pack --ignore-scripts` into `<downloads>/npm-pack/` and
only read (no code from either repo or tarball was executed).

Citation conventions

- **[src]** read in source. Paths are relative to the Perspective repo root unless prefixed
  `regular-table:` (relative to the regular-table repo root) or `npm:` (inside the extracted
  tarball `agent-a/npm-pack/x-<pkg>/package/`).
- **[doc]** stated in upstream docs, READMEs or code comments.
- **[inf]** my inference; the basis is named. Nothing tagged [inf] was run or measured.
- Nothing below is a measured performance result. Where docs make performance claims they are
  quoted as claims.

Package / crate map [src]

| npm package | source dir | what it is |
|---|---|---|
| `@perspective-dev/client` | `rust/perspective-js` (+ `rust/perspective-client`) | Rust `Client`/`Table`/`View` compiled to WASM with wasm-bindgen, plus TS glue (`perspective.browser.ts`, `perspective.node.ts`, worker entry) |
| `@perspective-dev/server` | `rust/perspective-server` (`cpp/perspective`) | the C++ engine compiled with Emscripten: `perspective-server.wasm`, `perspective-server.memory64.wasm` |
| `@perspective-dev/viewer` | `rust/perspective-viewer` | `<perspective-viewer>` custom element, Rust + Yew compiled to WASM; depends on the `perspective-js` and `perspective-client` crates (`rust/perspective-viewer/Cargo.toml:50-51`) |
| `@perspective-dev/viewer-datagrid` | `packages/viewer-datagrid` | the Datagrid plugin, plain TypeScript; depends on `regular-table` pinned `=0.9.2` (`pnpm-workspace.yaml` catalog `"regular-table": "=0.9.2"`; `npm:` viewer-datagrid `package.json` `"regular-table": "=0.9.2"`) |

---

## 1. Layers, threads, processes

### 1.1 What runs where (local engine: `perspective.worker()`)

Main thread

- **Viewer (Rust/Yew WASM).** `<perspective-viewer>` is registered by the viewer WASM's
  `init`: `rust/perspective-viewer/src/rust/lib.rs:337-341`
  `pub fn js_init(module: js_sys::WebAssembly::Module, url: web_sys::Url) { … define_web_components!(…)`.
  [src] The glue JS is loaded on the main thread by dynamic `import(url)` of a URL produced by the
  worker-bundling plugin and then instantiated in-page:
  `rust/perspective-viewer/src/ts/bootstrap.ts:73-82`
  `const url = await worker_url.getWorkerURL(); … import(/* webpackIgnore: true */ /* @vite-ignore */ url) … await glue.default({ module_or_path: module }); await glue.init(module, url);`.
  [src] In production builds that URL is a Blob URL: `tools/esbuild-plugin/worker.js:25-29`
  "`inline: true` (default, prod). The subbuild's bytes are embedded as a JS string in the parent
  bundle. `getWorkerURL()` creates a Blob URL at runtime". [doc] → in a trace the viewer glue script
  appears under a `blob:` URL. [inf from those two citations]
- **The `Client` (Rust WASM) also runs on the main thread, inside the viewer's WASM instance.**
  When the `viewer` binary is registered it becomes the page-wide client runtime:
  `rust/perspective-js/src/ts/wasm/registry.ts:223-228`
  `s.viewer = materialize(s.sources.viewer!).then(s.viewer_provider!); if (s.client === undefined) { s.client = s.viewer; s.client_origin = "viewer";`
  and the doc comment `registry.ts:377-378` "`viewer` (`perspective-viewer.wasm`, which also backs
  every `Client`)". [src][doc] So `perspective.worker()`, `client.table()`, `table.view()`,
  `view.to_columns_string()` are wasm-bindgen calls into `perspective-viewer.wasm` on the main
  thread; protobuf encode/decode happens there. (If only `client` is registered, the same code runs
  from `perspective-js.wasm` instead — `registry.ts:444-475`.)
- **Datagrid plugin (JS)** — `<perspective-viewer-datagrid>` custom element,
  `packages/viewer-datagrid/src/ts/index.ts:40-49`
  `customElements.define("perspective-viewer-datagrid", HTMLPerspectiveViewerDatagridPluginElement); … PerspectiveViewer.registerPlugin("perspective-viewer-datagrid");`.
  [src] It is mounted in the viewer's light DOM (`rust/perspective-viewer/src/rust/renderer/activate.rs:43-47`
  `viewer.prepend_with_node_1(html_plugin)`), and puts a `<regular-table>` in its own shadow root
  (`packages/viewer-datagrid/src/ts/plugin/activate.ts:73` `this.shadowRoot!.appendChild(this.regular_table);`). [src]
- **regular-table (JS)** — the `<regular-table>` custom element; virtual scroll, DOM writes,
  style-listener dispatch. [src] (see §2, §4)

Web Worker (dedicated, named `perspective-server`)

- **Engine (C++ → Emscripten WASM, `@perspective-dev/server`)** plus a small TS loop from
  `@perspective-dev/client`. The worker is created by
  `rust/perspective-js/src/ts/perspective.browser.ts:335-340`
  `return await initializePerspectiveWorker({ type: "module", name: "perspective-server" });` [src]
  and its entry is `rust/perspective-js/src/ts/perspective-server.worker.ts`. On `{cmd:"init"}` it
  compiles the engine and creates a server + session:
  `perspective-server.worker.ts:29-41`
  `const module = await compile_perspective(msg.data.args[0]); GLOBAL_SERVER = new PerspectiveServer(module, { on_poll_request: () => POLL_THREAD.on_poll_request() }); POLL_THREAD = new PerspectivePollThread(GLOBAL_SERVER); … SESSION = GLOBAL_SERVER.make_session(async (resp) => { const f = resp.slice().buffer; this.postMessage(f, { transfer: [f] }); });` [src]
- Fallback: if `new Worker(...)` throws, or the page is `file://`, the same worker source runs on the
  main thread behind a `MessageChannel` (`tools/esbuild-plugin/worker.js:40-47`
  `console.warn("Running perspective in single-threaded mode"); const channel = new MessageChannel();`,
  and `:52-73`). [src] Watch for that console warning before trusting a trace.
- The worker contains no Rust client code; it speaks raw protobuf bytes. [inf from
  `perspective-server.worker.ts:13-18` imports: only `wasm/engine.ts` and `wasm/emscripten_api.ts`]
- [doc] `docs/md/how_to/javascript/worker.md:8-15` "Perspective's Web Worker client is actually a
  `Client` and `Server` rolled into one … All calculation and data accumulation will occur in this
  separate process." [doc] `docs/md/benchmarks.md:86` "WebAssembly is single-threaded per worker".

### 1.2 What changes with `perspective.websocket(url)`

- Only the transport closure handed to the Rust `Client` changes. `worker()` builds
  `new Client(async (proto) => { const f = proto.slice().buffer; port.postMessage(f, { transfer: [f] }); }, …)`
  (`rust/perspective-js/src/ts/wasm/browser.ts:100-104`) and wires
  `port.onmessage = (json) => { client.handle_response(json.data); }` (`browser.ts:112-114`).
  `websocket()` builds `client = new Client(send_message, on_close)`
  (`rust/perspective-js/src/ts/websocket.ts:92`) where
  `send_message` does `const buffer = proto.slice().buffer; ws.send(buffer);` (`websocket.ts:82-83`),
  with `ws.binaryType = "arraybuffer"` (`websocket.ts:48`) and
  `ws.onmessage = (event) => { client.handle_response(event.data); }` (`websocket.ts:63-65`). [src]
- So: **same `.proto`, same bytes; one binary WebSocket frame per protobuf `Request`/`Response`**
  instead of one `postMessage` with a transferred `ArrayBuffer`. [src for each side; "one frame per
  message" is [inf] from `ws.send(buffer)` being called once per `send_request`]
- The viewer, the Rust `Client` WASM, the datagrid and regular-table still run on the main thread;
  no engine worker is created unless the page also calls `perspective.worker()`. [inf from the two
  constructors above; the engine binary is only compiled on first `worker()`:
  `perspective.browser.ts:138` "Selection and download are deferred to the first `worker()` call" [doc]]
  Caveat: passing `server: fetch(SERVER_WASM)` (an already-started promise, as the examples do)
  starts the HTTP download immediately even if `worker()` is never called; only a thunk
  (`() => fetch(...)`) defers it. [inf from `registry.ts:49-52` `WasmSource` accepting a promise or thunk
  and `registry.ts:165` `typeof source === "function" ? await source() : await source`]
- [doc] `docs/md/explanation/architecture/server_only.md:12-16` "interactive performance is poor, as
  every user interaction must page the server to render. Operations like scrolling are not as
  responsive and can be impacted by network latency … Does not use WebAssembly." (The last sentence
  is about the engine; the client/viewer WASM is still used — [inf] from the code above.)
- Reconnect/error: `ws.onerror`/`ws.onclose` call `client.handle_error(msg, connect)`
  (`websocket.ts:49-61`), which errors all pending one-shot calls with a synthetic `ServerError`
  (`rust/perspective-client/src/rust/client.rs:385-406`). [src]

### 1.3 One client call end to end (`view.to_columns_string(window)`)

Encoding: **protobuf (proto3)**, file `rust/perspective-client/perspective.proto`, `package perspective.proto;`
(`perspective.proto:13,17`). Envelope `message Request { uint32 msg_id = 1; string entity_id = 2; oneof client_req { … } }`
(`:116-166`) and `message Response { uint32 msg_id = 1; string entity_id = 2; oneof client_resp { … ServerError server_error = 50; } }`
(`:168-213`). The call's messages: `message ViewToColumnsStringReq { ViewPort viewport = 1; optional bool id = 2; optional bool index = 3; optional bool formatted = 4; }`
and `message ViewToColumnsStringResp { string json_string = 1; }` (`:535-544`);
`message ViewPort { optional uint32 start_row = 1; optional uint32 start_col = 2; optional uint32 end_row = 3; optional uint32 end_col = 4; optional bool machine_column_names = 5; }` (`:84-89`). [src]
The **payload inside the protobuf is a JSON string** (column-oriented), not Arrow.

Client send (main thread, Rust WASM)

1. JS `view.to_columns_string(window)` → `rust/perspective-js/src/rust/view.rs:232-236`
   `let window = window.into_serde_ext::<Option<ViewWindow>>()?; let json = self.0.to_columns_string(window.unwrap_or_default()).await?;` [src]
2. `rust/perspective-client/src/rust/view.rs:523-537` builds
   `ClientReq::ViewToColumnsStringReq(ViewToColumnsStringReq { viewport: Some(window.clone().into()), id: window.id, index: window.index, formatted: window.formatted })`
   and awaits `self.client.oneshot(&msg)`. Window floats are floored/ceiled:
   `view.rs:128-131` `start_row: window.start_row.map(|x| x.floor() as u32), … end_row: window.end_row.map(|x| x.ceil() as u32)`. `entity_id` is the view name and `msg_id` a per-client counter (`view.rs:359-365`). [src]
3. `Client::oneshot` (`rust/perspective-client/src/rust/client.rs:482-492`) creates a
   `futures::channel::oneshot` and calls `subscribe_once`, which stores the callback under
   `msg.msg_id` in `subscriptions_once` and sends: `client.rs:447-453`
   `self.subscriptions_once.write().await.insert(msg.msg_id, on_update); … (self.send)(msg).await`. [src]
4. `send` = prost encode + JS callback: `client.rs:283-287`
   `let mut bytes: Vec<u8> = Vec::new(); req.encode(&mut bytes).unwrap(); … send_request(bytes).await`;
   the JS callback receives a view over WASM memory: `rust/perspective-js/src/rust/client.rs:226-231`
   `let buff2 = unsafe { js_sys::Uint8Array::view_mut_raw(v.as_mut_ptr(), v.len()) }; send_request.call1(&JsValue::UNDEFINED, &buff2)`. [src]
5. Transport: worker → `const f = proto.slice().buffer; port.postMessage(f, { transfer: [f] });`
   (`wasm/browser.ts:101-104`: one copy out of WASM memory, then a transfer). WebSocket →
   `ws.send(proto.slice().buffer)` (`websocket.ts:82-83`). [src]

Worker receive loop (local engine)

6. `perspective-server.worker.ts:45-46` `await SESSION?.handle_request(new Uint8Array(msg.data));` [src]
7. `PerspectiveSession.handle_request` (`rust/perspective-js/src/ts/wasm/engine.ts:154-185`): copies the
   request into the engine heap (`convert_typed_array_to_pointer`, `engine.ts:209-226`:
   `core._psp_alloc(...)`, `core.HEAPU8.set(array, addr)`), then under a server-wide FIFO `AsyncLock`
   calls `this.mod._psp_handle_request(this.server, this.client_id, viewPtr, len)` (`engine.ts:163-170`). [src]
8. Engine: `psp_handle_request` (`rust/perspective-server/cpp/perspective/src/cpp/binding_api.cpp:87-96`)
   → `ProtoServer::handle_request` (`.../cpp/server.cpp:1099`): `req_env.ParseFromArray(data.data(), data.size());`
   (`:1104`) → `_handle_request` (`:2212`) → `case proto::Request::kViewToColumnsStringReq:` (`:3556-3594`)
   `auto json_str = view->to_columns(dims.start_row, dims.end_row, dims.start_col, dims.end_col, …, r.formatted(), r.index(), r.id(), …); … view_cols_str->set_json_string(json_str);`
   → `resp.data.SerializeAsString()` (`:1114`). Responses are returned as a C array of
   `(data*, len, client_id)` (`binding_api.cpp:60-75`). [src]
9. `decode_api_responses` (`engine.ts:253-309`) reads that array out of `HEAPU8` and calls the
   session callback for each message → `const f = resp.slice().buffer; this.postMessage(f, { transfer: [f] });`
   (`perspective-server.worker.ts:38-41`). [src]
10. After every request the session asks for a poll: `engine.ts:178-182`
    `if (this.on_poll_request) { await this.on_poll_request(); } else { await this.poll(); }` (see §3.1). [src]

Response dispatch (main thread)

11. `port.onmessage` / `ws.onmessage` → `client.handle_response(data)` →
    `rust/perspective-js/src/rust/client.rs:247-251` `let uint8array = Uint8Array::new(value); let slice = uint8array.to_vec(); self.client.handle_response(&slice).await?;` (copy into WASM). [src]
12. `Client::handle_response` (`rust/perspective-client/src/rust/client.rs:324-339`):
    `let msg = Response::decode(msg)?; … if let Some(handler) = (*wr).remove(&msg.msg_id) { drop(wr); handler(msg)?; return Ok(true); } let handler = self.subscriptions.read().await.get(&msg.msg_id).cloned(); … handler(msg).await?;`
    — one-shot calls resolve by `msg_id` from `subscriptions_once`; streaming callbacks
    (`on_update`) stay registered in `subscriptions`. [src]
13. The oneshot receiver wakes `to_columns_string`, which returns the Rust `String`; wasm-bindgen
    turns it into a JS string and resolves the JS promise (`perspective-js/src/rust/view.rs:234-235`). [src]
    `view.to_columns()` is the same call followed by `js_sys::JSON::parse(&json)` in WASM-side glue
    (`view.rs:241-243`). [src]

Server receive loop (remote, Node `WebSocketServer`) — see §6(b). Python/Rust servers use the
native engine through `LocalSession::handle_request` (`rust/perspective-server/src/local_session.rs:39-64`)
with the same `handle_request` → `poll`/`on_poll_request` shape. [src]

Identifiers worth searching for in a trace: `handle_response`, `handle_request`, `_psp_handle_request`,
`_psp_poll`, `_psp_alloc`, `to_columns_string`, `postMessage`. Caveats: the published JS bundles are
minified (local function names such as `dataListener`, `consolidatedStyleListener`,
`decode_api_responses`, `PerspectivePollThread` do not survive — `grep -c` returns 0 in
`npm:` `dist/esm/perspective-viewer-datagrid.js` and `dist/cdn/perspective-server.worker.js`),
property/method names such as `to_columns_string`, `handle_request`, `on_poll_request` do survive,
and `.js.map` files with `sourcesContent` ship next to every bundle. [src: grep of the extracted
tarballs] regular-table's own build mangles `_`-prefixed properties
(`regular-table:build.mjs:33` `mangleProps: /^[_#]/`), so `_on_scroll` appears as e.g. `this.O` in
`npm:` `dist/cdn/perspective-viewer-datagrid.js` (`addEventListener("scroll",this.O.bind(this)`). [src]
The published `.wasm` files are small self-extracting wrappers with the real module compressed in a
`psp-runtime` custom section (section listing of the three binaries: code section 11 417 bytes,
`psp-runtime` 2.6 MB / 1.7 MB / 0.6 MB; loader `rust/perspective-js/src/ts/wasm/decompress.ts:19-50`
`WebAssembly.Module.customSections(bin.module, "psp-runtime") … inst.compile(payload.byteLength, raw_length)`). [src]
Expect two WASM compilations per binary at startup; whether the inner modules keep a `name` section
is **not determined** (would require running the extractor).

---

## 2. The datagrid's draw

All paths in this section are under `packages/viewer-datagrid/src/ts/` unless noted.

### 2.1 Creating and configuring `<regular-table>`

- Created once per plugin element in the constructor: `custom_elements/datagrid.ts:142-155`
  `this.regular_table = document.createElement("regular-table") as RegularTableElement; this.regular_table.part = "regular-table"; … const shadow = this.attachShadow({ mode: "open" }); shadow.adoptedStyleSheets.push(Elem._sheet);` [src]
- Attached lazily on first `activate()`: `plugin/activate.ts:71-73`
  `if (!this._initialized) { this.innerHTML = ""; this.shadowRoot!.appendChild(this.regular_table);` [src]
- Data listener + options are (re)installed by `createModel` on **every** `plugin.draw()`
  (`plugin/draw.ts:24-26` `if (this.parentElement) { await this.activate(view); }`;
  `plugin/activate.ts:75` first time, `:271` thereafter): `model/create.ts:370-386`
  `regular.setDataListener(createDataListener(this.parentElement, this).bind(model, regular), { virtual_mode: (window.getComputedStyle(regular).getPropertyValue("--datagrid-virtual-mode")?.trim() || "both"), column_classes: true });` [src]
  - `virtual_mode` defaults to `"both"`; the only override is the CSS custom property
    `--datagrid-virtual-mode` (no other reference in the repo — `grep` finds only `create.ts:378`). [src]
  - `column_classes: true` makes regular-table tag cells with `rt-col-{size_key}`
    (`regular-table:src/ts/view_model.ts:63-82`), which the plugin uses for alignment rules (§2.5). [src]
  - Each `setDataListener` without `preserve_state` sets `_invalid_schema = true` and replaces
    `_view_cache` (`regular-table:src/ts/regular-table.ts:361-373`). [src] The data listener closure is new
    each time, so its `last_meta`/`last_ids` (used for pulse) start empty (`data_listener/index.ts:77-82`). [src]
- `createModel` round trips (once per `plugin.draw()`): `view.get_config()` (`model/create.ts:217`), then
  in parallel `table.schema()`, `view.num_rows()`, `view.schema()`, `view.expression_schema()`,
  `viewer.getEditPort({panel})`, `table.get_features()` (`model/create.ts:272-281`); before it,
  `viewer.getTable({ panel })` (`plugin/activate.ts:69`). It also calls `readThemeStyle(regular)`, which
  does `window.getComputedStyle(regular).getPropertyValue(...)` for ~7 properties plus a palette walk
  (`model/create.ts:107-114,157-208`). [src] `get_features` is cached client-side after the first call
  (`rust/perspective-client/src/rust/client.rs:494-515`). [src]
- Row height: not fixed by default. The CSS gives rows `height: var(--psp-datagrid--row--height, 23px)`
  (`../css/regular_table.css:431`; `19px` fallback in `../css/pro.css:101`) and regular-table measures a
  probe row (`regular-table:src/ts/scroll_panel.ts:990-992` `if (!this._column_sizes.row_height) { this._probe_row_height(); }`).
  If `plugin_config.row_height` is set, the plugin pins it: sets the CSS var
  (`plugin/restore.ts:172-176`) and returns it in every `DataResponse`
  (`data_listener/index.ts:485-487` `if (this._row_height !== undefined) { result.row_height = this._row_height; }`). [src]

### 2.2 Entry points that draw

| caller (viewer) | plugin method | what it does |
|---|---|---|
| new engine `View` (`BindDisposition::Rebuilt`) | `draw(view)` → `plugin/draw.ts:20-66` | `activate(view)` (→ `createModel`) then `this.regular_table.draw({ invalid_columns: true } as any)`; applies pending `scrollTop = 0` / `scrollLeft = 0` / `psp-deselect-all` / `resetAutoSize()` resets; awaits the draw |
| data update or config delta on the same `View` | `update(view)` → `custom_elements/datagrid.ts:247-267` | `this.model._num_rows = await view.num_rows();` (or `view.dimensions()` when `split_by` is set) then `await this.regular_table.draw();` |
| box resize | `resize()` → `datagrid.ts:320-328` | `await this.regular_table.draw();` |
| host layout presize | `presize(w,h)` → `datagrid.ts:346-363` | `this.regular_table.predraw(...)` returning a commit closure |

[src] `invalid_columns` is not an option regular-table 0.9.2 reads (`grep -rn invalid_columns` over
`regular-table:src` returns nothing; `DrawOptions` handling at `regular-table:src/ts/scroll_panel.ts:985`
destructures only `invalid_viewport`, `preserve_width`, plus `options.cache`/`options.throttle`). [src]

### 2.3 The data listener (`createDataListener`, `data_listener/index.ts:67-491`)

Signature regular-table calls: `dataListener(regularTable, x0, y0, x1, y1)` (`index.ts:84-91`). [src]

Per call with a non-empty window (`x1 - x0 > 0 && y1 - y0 > 0`, `index.ts:107`):

- **One `Promise.all` of two RPCs** — `index.ts:117-123`:
  `const [x, z] = await Promise.all([ this._view.to_columns_string({ ...new_window, end_row: y1 + lookahead } as any), this._view.num_columns() ]);`
  with `new_window = { start_row: y0, start_col: x0, end_row: y1, end_col: x1, id: true }`
  (`index.ts:93-99`) and `lookahead = this._config.group_by.length > 0 && y1 < this._num_rows ? 1 : 0`
  (`index.ts:114-115`; the extra row is sliced off again at `:135-139` and only feeds tree
  expand/collapse state). [src]
  - `to_columns_string` → `ViewToColumnsStringReq` (§1.3). `id: true` adds an `__ID__` column of row
    keys; grouped views also return `__ROW_PATH__` (`index.ts:54-58,203-207`). [src]
  - `num_columns()` is `self.0.dimensions().await?.num_view_columns`
    (`rust/perspective-js/src/rust/view.rs:433-437`) → a `ViewDimensionsReq`. [src]
  - **Format: a JSON string of columns**, parsed on the main thread: `index.ts:126`
    `columns = JSON.parse(x as string) as ColumnData;`. Not Arrow, not the pre-parsed `to_columns()`. [src]
  - No extra columns are requested beyond `[x0, x1)`; no row overscan is added by the plugin. Any
    overscan comes from regular-table's own viewport math. [src for the window; [inf] for "any overscan is regular-table's"]
- **Conditional second batch**, only when the fetched column paths differ from the cached
  `this._column_paths` (`index.ts:151-163`): `index.ts:165-174`
  `await Promise.all([ this._view.schema(), this._view.expression_schema(), is_pivoted ? this._view.column_paths({ start_col: x0, end_col: x1 }) : Promise.resolve(null) ])`. [src]
  So first draw after a new view, and horizontal scroll into not-yet-seen columns, cost 2–3 extra RPCs.
- Per call with an empty window (regular-table's dimension probe `view(0, 0, 0, 0)`,
  `regular-table:src/ts/table.ts:700-703`): only `num_columns = await this._view.num_columns();`
  (`index.ts:220-222`). The plugin calls this a "phantom" call (`index.ts:454`). [src]

Row count: `num_rows` in the `DataResponse` is the cached `this._num_rows` (`index.ts:473`), refreshed
only by `createModel` (`model/create.ts:274,339`) and by `update()` (`datagrid.ts:260-264`). [src]

Caching between draws [src]

- No cell-data cache: every non-empty call refetches the whole window (`index.ts:117-126`).
- Cached on the model: `_column_paths`, `_column_path_area`, `_schema`, `_column_types`,
  `_is_editable` (only refreshed on `changed_cols`, `index.ts:163-200`), `_num_rows`, `_last_window`,
  `_ids`, `_reverse_ids`, `_reverse_columns` (`index.ts:202-219`), previous-draw values
  `last_meta`/`last_ids`/… for pulse (`index.ts:455-467`), command button DOM blocks
  (`_command_blocks`, `index.ts:243-252`).
- `Intl` formatter instances are cached in a module-level `FormatterCache`
  (`data_listener/format_cell.ts:22`), keyed by `JSON.stringify([type, date_format, number_format])`
  (`data_listener/formatter_cache.ts:70-74`).
- regular-table caches the last `DataResponse` for its dimension probe only when drawing with
  `cache: true` (scroll path), `regular-table:src/ts/table.ts:700-706`.

Round trips per regular-table draw (window non-empty, columns unchanged) — composed from the above:

| draw kind | data-listener calls | RPCs issued by the listener |
|---|---|---|
| `regular_table.draw()` (update / resize / first draw): `_update_dim_state(options.cache)` resets and probes (`regular-table:src/ts/scroll_panel.ts:369-373`), then `table_model.draw` fetches (`regular-table:src/ts/table.ts:723-728`) | probe `(0,0,0,0)` + window | `ViewDimensionsReq` (probe) + `ViewToColumnsStringReq` + `ViewDimensionsReq` |
| scroll (`_on_scroll` → `predraw({cache: true})`, §4) | window only | `ViewToColumnsStringReq` + `ViewDimensionsReq` |
| either, when regular-table needs more columns to fill the width (`_fetchMissingColumns`, `regular-table:src/ts/table.ts:280-298`, called from the render loop `:901-924`) | + one call per extension | + one `to_columns_string` + one `ViewDimensionsReq` each |

[inf: the table is my composition of the cited call sites; counts not observed at runtime]

### 2.4 What happens to the result before returning to regular-table

- Per column in `[x0, min(x1, _column_paths.length))` (`index.ts:339-431`), per cell
  (`index.ts:380-412`): `format_cell.call(this, name, x, columns_config)`. [src]
- `format_cell` (`data_listener/format_cell.ts:34-72`): `null` → `null`; numeric with `fg_mode`
  `"bar"`/`"label-bar"` → `""`; string with `link === true` → builds an `<a>` element per cell
  (`:58-63`); otherwise `const formatter = FORMAT_CACHE.get(type, plugin); return formatter ? formatter.format(val) : String(val);`
  (`:69-70`). [src]
- Formatters are `Intl.NumberFormat` for `integer`/`float`, `Intl.DateTimeFormat` for
  `date`/`datetime`, a trivial `BooleanFormatter`, and none (→ `String(val)`) for strings
  (`data_listener/formatter_cache.ts:21-59,77-98`; constructors at
  `rust/perspective-viewer/src/ts/column-format.ts:177` `new Intl.NumberFormat(navigator.languages as string[], opts)`,
  `:223`, `:238`). [src] So **yes: `Intl.*.format()` is called once per visible numeric/date cell per
  draw**, on the main thread, and the cache lookup itself does a `JSON.stringify` per cell
  (`formatter_cache.ts:70`). [src; "per cell" follows from `format_cell` being called in the
  `column.map` at `index.ts:381-386`]
- Row headers (grouped views) are formatted the same way per path element
  (`data_listener/format_tree_header.ts:38-65`, calling `format_cell(..., use_table_schema = true)`). [src]
- `metadata.push(column)` passes the **raw** column values to regular-table as cell metadata
  (`index.ts:414`), which is what style handlers read as `metadata.user`
  (`regular-table:src/ts/tbody.ts:198-199` `meta.user = column_data_listener_metadata[ridx];`). [src]
- Other per-call work: `effective_command_scopes(plugin)` → two `viewer.queryCommands(...)` calls into
  the viewer WASM (`commands.ts:96-114,321-332`; called at `index.ts:102-103`);
  `reconcile_column_widths(this, regularTable, x0, x1)` → `regular_table.saveColumnSizes()` and
  sometimes `restoreColumnSizes()` (`model/column_overrides.ts:27-86`, called at `index.ts:317-319`);
  header label formatting for split levels (`index.ts:415-423`); `viewer.hasAttribute("settings")` /
  `viewer.getActivePanel()` (`index.ts:229-233`); building `Map`s of ids/columns (`index.ts:209-219`);
  word-wrap boxes `document.createElement("div")` per wrapped cell (`index.ts:497-511`). [src]
- Returned `DataResponse`: `num_column_headers`, `num_row_headers`, `num_rows`, `num_columns`,
  `row_headers`, `column_headers`, `data` (strings or `HTMLElement`s), `metadata`,
  `column_header_merge_depth`, optional `row_height` (`index.ts:469-489`). [src]

### 2.5 Style listeners / per-draw DOM passes

Two style listeners are registered on the `<regular-table>`, in this order (`plugin/activate.ts:156,164`):

1. **Selection** — `event_handlers/select_region.ts:65-67`
   `table.addStyleListener(() => applyMouseAreaSelections(datagrid, table, className));` [src]
   - Default `edit_mode` `READ_ONLY` and nothing selected: does nothing unless
     `_selection_state.dirty`, in which case one `table.querySelectorAll("tbody td, tbody th")` pass
     removing the class (`select_region.ts:415-421`). [src]
   - Selection modes (`SELECT_REGION`/`SELECT_ROW`/`SELECT_COLUMN`): `table.querySelectorAll("tbody td")`,
     and per `td`: `table.getMeta(td)`, predicate per selected area, `td.classList.add/remove("psp-select-region")`
     (`select_region.ts:424-461`); plus `viewer.setSelection(...)` per draw (`:394-398`, `:358`). [src]
2. **Consolidated** — `plugin/activate.ts:164-172`
   `this.regular_table.addStyleListener(createConsolidatedStyleListener(this, this.model, this.regular_table, viewer, selected_position_map));` [src]
   [doc] `style_handlers/consolidated.ts:32-35` "Consolidated style listener that handles all cell
   styling in a single pass. This eliminates redundant DOM traversals and reduces layout thrashing
   by: 1. Collecting all cell metadata in a read phase 2. Applying all styles in a write phase".
   Per draw it:
   - walks `tbody` rows and cells, `regularTable.getMeta(cell)` per cell, and toggles `psp-zebra` on
     each `<tr>` (`consolidated.ts:57-88`); walks `thead` rows/cells with `getMeta` (`:91-112`). [src]
   - `applyBodyCellStyles` (`style_handlers/body.ts:135-476`), for every body cell and row-header cell:
     compute a per-column `ColState` once per column (`:161-259`), compute a `bits` key
     (null / sign / selection, `:301-328`), then **skip the cell if its memo matches**:
     `body.ts:332-343` `const memo = metadata.__psp_style_memo; if (memo !== undefined && memo.plugin === c.plugin && memo.type === c.type && memo.mods === c.mods && memo.theme === theme && memo.bits === bits && (!c.value_styled || memo.value === metadata.user)) { continue; }`. [src]
     The memo lives on regular-table's per-`<td>` metadata object, which regular-table reuses across
     draws (`regular-table:src/ts/view_model.ts:101-111` `let metadata = METADATA_MAP.get(td); if (!metadata) { metadata = { value: undefined } as CellMetadata; METADATA_MAP.set(td, metadata); }`). [src]
     Row-header (`<th>`) cells are never memo-skipped (`if (!isHeader)` guards the memo, `body.ts:330`). [src]
     For a cell that is not skipped it writes: `classList.toggle` for `psp-split-total`,
     `psp-split-subtotal` (`:365-373`), a type-specific handler (below), `psp-bool-type`, `psp-null`,
     `psp-menu-open`, `psp-color-mode-bar`, `psp-color-mode-label-bar` (`:397-416`),
     `psp-select-region-inactive`/`psp-select-region` (`:428-444`), and for body cells
     `td.style.fontFamily/fontSize/fontWeight/fontStyle`, `--psp-datagrid--wrap-lines`, `psp-editable`,
     `tabindex`, `boolean-editable` (`:446-472`). [src]
     Type-specific handlers: `cell_style_numeric` (`style_handlers/table_cell/numeric.ts:97-220`:
     `td.style.position`, `animation`, `backgroundColor`, `color`, bar custom properties
     `--psp-bar-size`/`--psp-bar-anchor`/`--psp-label-bar-color`/`--psp-label-bar-bg`, `data-psp-label`
     attribute — with default config (`fg_mode` `"color"`, `bg_mode` `"disabled"`, `:105-106`) that is
     `td.style.color = hex` by sign); `cell_style_boolean` (`table_cell/boolean.ts:20-40`),
     `cell_style_string` (`table_cell/string.ts:69-119`), `cell_style_datetime`
     (`table_cell/datetime.ts:26-59`) — each ends in `td.style.color = …; td.style.backgroundColor = …`;
     `cell_style_row_header` (`table_cell/row_header.ts:20-77`: `psp-tree-*` class toggles). [src]
     Pulse (`bg_mode: "pulse"`): `style_cell_flash` compares the value with the previous draw's
     `last_meta` by row id + column path and sets `td.style.animation = "pulse_pos 0.5s linear"` /
     `"pulse_neg 0.5s linear"` (alternating with `pulse_pos2`/`pulse_neg2` to restart;
     `table_cell/cell_flash.ts:16-70`; keyframes at `../css/regular_table.css:572-620`). Only applies when
     the viewport is unchanged (`model._is_old_viewport`, `cell_flash.ts:32`). [src]
     Ends with `sync_column_alignment(regularTable, alignments)` (`body.ts:475`): alignment is done
     with one generated CSS rule per column `size_key` in an adopted stylesheet rather than per-cell
     classes (`style_handlers/column_alignment.ts:59-64,112-153`). [src][doc]
   - `applyGroupHeaderStyles` (`style_handlers/group_header.ts:35-115`): for every `thead` cell,
     `td.style.backgroundColor = ""` and ~14 `classList.toggle` calls, plus border classification for
     split-by group rows. No memo. [src]
   - `applyColumnHeaderStyles` (`style_handlers/editable.ts:24-120`) → `styleColumnHeaderRow`
     (`style_handlers/column_header.ts:95-232`): row ids, `viewer.classList.toggle("psp-menu-open", …)`,
     and per header cell ~16 `classList.toggle` calls (sort direction classes, `psp-menu-enabled`,
     `psp-sort-enabled`, …) plus `regularTable.saveColumnSizes()[metadata.size_key!]` **per header
     cell** (`column_header.ts:220-223`). No memo. [src]
   - `applyFocusStyle` (`style_handlers/focus.ts:22-55`): only when a cell position is selected for
     editing; scans collected cells and may call `td.focus({ preventScroll: true })`. [src]

regular-table invokes all style listeners after each render-pass step that yields `"style"`:
awaited in `draw()` (`regular-table:src/ts/scroll_panel.ts:1039-1041`), not awaited in a `predraw`
commit (`regular-table:src/ts/scroll_panel.ts:319-326`). A render pass can yield `"style"` more than
once when columns are fetched incrementally (`regular-table:src/ts/table.ts:942,1021,1064`). [src]

---

## 3. Update path (streaming)

### 3.1 When the engine processes an update

`table.update(rows)` (JS) → rows are stringified in WASM glue
(`rust/perspective-js/src/rust/table_data.rs:145-147` `let rows = JSON::stringify(value)?…; Ok(Some(UpdateData::JsonRows(rows)))`;
`ArrayBuffer`/`Uint8Array` → `UpdateData::Arrow`, `:114-144`; object of arrays → `JsonColumns`, `:74-78`)
→ `TableUpdateReq { data: MakeTableData, port_id }` (`rust/perspective-client/src/rust/table.rs:810-820`;
`perspective.proto:46-56,497-501` with `bytes from_arrow = 3; string from_rows = 4; string from_cols = 5;`). [src]

Engine side: `case proto::Request::kTableUpdateReq` (`server.cpp:3053-3105`) parses and **appends to the
table's input port**, marks the table dirty, and answers immediately:
`table->update_rows(r.data().from_rows(), r.port_id()); … m_resources.mark_table_dirty(req.entity_id()); proto::Response resp; resp.mutable_table_update_resp(); push_resp(std::move(resp));`.
Appending: `t_pool::send` sets `m_data_remaining.store(true)` and calls `m_gnodes[gnode_id]->send(port_id, table)`
(`.../cpp/pool.cpp:119-128`) → `t_port::send … m_table->append(table);` (`.../cpp/port.cpp:57-59`). [src]
So the promise returned by `table.update()` resolves when the data is queued, not when views are updated. [inf from the handler returning `TableUpdateResp` before any `_process`]

The queued data is applied to views ("processed") in one of two modes, selected by the
`realtime_mode` constructor flag (`.../include/perspective/server.h:705` `ProtoServer(bool realtime_mode)`):

- **Poll mode (`realtime_mode = true`)** — used whenever the host passes `on_poll_request`:
  `engine.ts:100-102` `this.server = module._psp_new_server(!!options?.on_poll_request ? 1 : 0)`. The
  **browser worker always does** (`perspective-server.worker.ts:31-33`). In this mode requests never
  process pending data (`server.cpp:2228-2230` `if (!m_realtime_mode) { handle_process_table(req, proto_resp); }`);
  only `poll()` does: `ProtoServer::_poll()` (`server.cpp:3945-3955`)
  `auto tables = m_resources.get_dirty_tables(); for (auto& [table, table_id] : tables) { _process_table_unchecked(table, table_id, resp_envs); } … m_resources.mark_all_tables_clean();`. [src]
  The poll is scheduled by `PerspectivePollThread` (`engine.ts:52-86`) — **a `setTimeout` with no delay
  argument (0 ms), at most one outstanding**:
  `engine.ts:59-69` `this.poll_handle = new Promise((resolve, reject) => setTimeout(() => this.server.poll().then(resolve).catch(reject).finally(() => { this.poll_handle = undefined; })));`
  and `engine.ts:75-85` `async on_poll_request() { if (!this.poll_handle) { await this.set_poll_handle(); } else { await this.poll_handle.then(() => { if (!this.poll_handle) { return this.set_poll_handle(); } }); } }`.
  `on_poll_request()` is awaited after **every** request of any kind (`engine.ts:178-179`). [src]
  There is no other timer, interval or debounce constant in the JS engine host. [src: only `setTimeout`
  in `engine.ts`/worker; confirmed in `npm:` `dist/cdn/perspective-server.worker.js`
  `setTimeout(()=>this.server.poll().then(r).catch(t).finally(()=>{this.poll_handle=void 0}))`]
- **Lazy mode (`realtime_mode = false`)** — no `on_poll_request`. Used by the **Node.js build**
  (`perspective.node.ts:300` `const SYNC_SERVER = new engine.PerspectiveServer(SYNC_MODULE);`, with the
  poll-thread variant commented out at `:302-307`) and by Python/Rust `Server()` without the kwarg.
  Pending data is processed (a) before any read-type request on that table/view — `needs_poll`
  (`server.cpp:1351-1400`: true for `kViewToColumnsStringReq`, `kViewDimensionsReq`, `kViewToArrowReq`,
  `kViewSchemaReq`, `kTableSizeReq`, `kTableMakeViewReq`, `kViewOnUpdateReq`, …; false for
  `kTableUpdateReq`) via `handle_process_table` (`server.cpp:1453-1476`), and (b) by the `poll()` the
  host runs right after every request (`engine.ts:180-181` `await this.poll();` → `_psp_poll`;
  Rust: `local_session.rs:57-61`). [src]

One process step = one notification per port, however many `update()` batches were queued:
`t_update_task::run` (`.../cpp/update_task.cpp:21-44`) loops ports, `bool did_notify_context = g->process(port_id); if (did_notify_context) { if (callback) { (*callback)(port_id); } … }`,
and the callback is `_notify_table` (`server.cpp:4221-4223`). [src]

Conflation at the engine boundary:

- Browser worker: every `update()` that arrives before the pending 0 ms timer fires is folded into the
  same `_poll()`; updates arriving during a poll get exactly one follow-up poll. [inf from
  `PerspectivePollThread` above + port append semantics; the achieved batching ratio depends on task
  ordering in the worker and must be measured]
- Node server: each `table.update()` is followed by its own `_psp_poll` (`engine.ts:180-181`), so by
  default there is one process step per `update()` call, except that calls issued without yielding
  can queue their `_psp_handle_request`s ahead of the first poll on the FIFO `AsyncLock`
  (`engine.ts:28-39,163-170,188-190`). [inf]
- [doc] `rust/perspective-server/src/server.rs:72-76` "`on_poll_request` A callback function which the
  `Server` will invoke when there are updates that need to be flushed, after which you must
  _eventually_ call [`Server::poll`] (or else no updates will be processed). This optimization allows
  batching updates, depending on context." [doc] `docs/md/explanation/view.md:9-11` "each [`View`] is
  _live_ with respect to the [`Table`]'s data, and will (within a conflation window) update with the
  latest state as its parent [`Table`] updates". No numeric "conflation window" is defined anywhere in
  docs or source that I found.

### 3.2 How `view.on_update` reaches the viewer

1. Engine: for each view on the processed table and each subscription, `_notify_table` emits a
   `Response` whose `msg_id` is the **subscription's original request id** and whose `client_id` is the
   subscriber's session: `server.cpp:4088-4104`
   `out.set_msg_id(subscription.id); out.set_entity_id(view_id); auto* r = out.mutable_view_on_update_resp(); r->set_port_id(port_id); r->set_reset(...); if (view->get_deltas_enabled()) { *r->mutable_delta() = *view->get_row_delta_as_arrow(); }`.
   Payload: `message ViewOnUpdateResp { optional bytes delta = 1; uint32 port_id = 2; bool reset = 3; }`
   (`perspective.proto:521-525`). [src]
2. Host: poll results are routed by `client_id` to the session callback → `postMessage` / `ws.send`
   (`engine.ts:123-134`). [src]
3. Client: `handle_response` finds the `msg_id` in `subscriptions` (not one-shot) and awaits the
   registered callback (`rust/perspective-client/src/rust/client.rs:334-338`); the callback was installed
   by `View::on_update` (`rust/perspective-client/src/rust/view.rs:640-665`,
   `self.client.subscribe(&msg, callback).await?`). [src]
4. Viewer: the subscription is created when the view is bound: `rust/perspective-viewer/src/rust/session.rs:1577-1585`
   `let on_update = self.metadata().get_features().unwrap().on_update.then(|| self.table_updated.callback()); ViewSubscription::new(view, config, effective, on_stats, on_update).await?`.
   It subscribes with **default options, i.e. no delta mode**: `rust/perspective-viewer/src/rust/session/view_subscription.rs:160-165`
   `view.on_update(Box::new(move |msg| emit.poll(msg)), OnUpdateOptions::default())` — so
   `ViewOnUpdateResp.delta` is absent and the message is only a "something changed" signal.
   [src; "no delta" follows from `mode: options.mode.map(...)` at `perspective-client view.rs:659-661`
   and `get_deltas_enabled` being set only for `ROW` mode at `server.cpp:3824-3829`]
5. Each notification is pushed through an unbounded channel (`LocalPollLoop`,
   `rust/perspective-js/src/rust/utils/local_poll_loop.rs:26-37`) and spawns `on_view_update`
   (`view_subscription.rs:151-157`), which first does **one RPC per notification**:
   `view_subscription.rs:84` `let dimensions = self.view.dimensions().await?;` (inside
   `update_view_stats`, emitting `on_stats` for the status bar), then `on_update.emit(())`
   (`view_subscription.rs:69-74`) → `session.table_updated`. [src]
   This step is **not conflated**: N notifications → N `ViewDimensionsReq` round trips.
   [inf from `ApiFuture::spawn(data.clone().on_view_update())` per channel item]

### 3.3 What the viewer calls on the plugin

- `table_updated` listener (`rust/perspective-viewer/src/rust/tasks/create_panel.rs:61-80`):
  `if renderer.is_plugin_hidden() { renderer.set_data_stale(); return; } … renderer.update_lazy(async move { Ok(session.get_view_with_dimensions()) })`.
  Hidden = plugin element `offsetParent` is null (`renderer/dispatch.rs:447-455`); a hidden panel only
  records a stale flag and is caught up with one `plugin.update` on activation
  (`tasks/pipeline.rs:386-390`). [src]
- `update_lazy` (`rust/perspective-viewer/src/rust/renderer/dispatch.rs:480-516`) →
  `draw_view(&guard, &view, true, dimensions)` → **`plugin.update(view, max_cols, max_rows, false)`**
  (`dispatch.rs:569-571`). `plugin.draw(...)` is used only for a new `View` (`dispatch.rs:572-574`;
  [doc] `rust/perspective-viewer/src/rust/js/plugin.rs:93-95` "Full render of a `View` that is NEW to
  this plugin — dispatched iff `bind_view` REBUILT the engine `View`"). A plugin without `update` gets
  `draw` instead (`js/plugin.rs:229-233`); the datagrid defines `update`. [src]
- Before dispatch, `draw_view` computes render limits, which for the datagrid (no `max_columns` in
  `get_static_config`, `custom_elements/datagrid.ts:190-209`) always costs a `view.schema()` RPC:
  `rust/perspective-viewer/src/rust/renderer/limits.rs:73-75` `(max_columns, _) => { let schema = view.schema().await?;`. [src]
- Datagrid `update(view)` (`packages/viewer-datagrid/src/ts/custom_elements/datagrid.ts:247-267`):
  `this.model._num_rows = await view.num_rows(); await this.regular_table.draw();` (plus
  `command_scopes_changed(this)` → two more `viewer.queryCommands` calls). No `createModel`, no
  `setDataListener`. [src]

RPCs per delivered update cycle with the datagrid, same columns, ungrouped view — composed from
§2.3 and §3.2–3.3: `ViewDimensionsReq` ×4 (viewer stats; plugin `num_rows`; regular-table probe;
listener `num_columns`), `ViewSchemaReq` ×1 (limits), `ViewToColumnsStringReq` ×1. The first of these
is per engine notification; the other five are per executed draw. [inf: composition, not observed]

### 3.4 What throttles redraws

There is **no `throttle` HTML attribute** in 5.9.2 (`grep -rn throttle` over
`rust/perspective-viewer/src` finds only the method and timer). The control is the method
`viewer.setThrottle(ms | undefined)`: `rust/perspective-viewer/src/rust/custom_elements/viewer.rs:1960-1987`,
[doc] "Determines the render throttling behavior. Can be an integer, for millisecond window to
throttle render event; or, if `None`, adaptive throttling will be calculated from the measured render
time of the last 5 frames." It applies to every panel's renderer (`viewer.rs:1979-1986`). `load()`
resets it to adaptive (`viewer.rs:601` `renderer.set_throttle(None);`). [src]

Algorithm [src], `rust/perspective-viewer/src/rust/renderer/dispatch.rs:480-516` +
`renderer/render_timer.rs` + `utils/debounce.rs`:

1. `update_lazy` runs its body through `self.draw_lock().debounce_with(...)`. The draw lock is a
   per-panel async mutex shared by all plugin dispatches (`renderer.rs:116` `draw_lock: DebounceMutex`). [src]
2. First thing inside the lock: `set_timeout(timer.get_throttle()).await?` (`dispatch.rs:487`) — a real
   `window.setTimeout` (`utils/browser/request_animation_frame.rs:85-95`). [src]
3. `get_throttle()` (`render_timer.rs:110-122`): `Constant(c)` → `c` ms (after `setThrottle(c)`);
   adaptive → `if state.render_times.len() < 5 { 0_i32 } else { f64::min(5000_f64, state.virtual_fps()) as i32 }`,
   where the misleadingly named `virtual_fps()` is the **mean of the stored render times in ms**
   (`render_timer.rs:146-150` `let sum = self.render_times.iter().sum::<f64>(); … sum / len`). [src]
   Constants: window = last **5** samples (`render_timer.rs:72-74`), cap = **5000 ms**, **0 ms** until 5
   samples exist. [src]
4. Samples: `capture_time` wraps the whole `draw_view` future and records `performance.now()` deltas
   (`render_timer.rs:58-83`; used at `dispatch.rs:421-434` and `:506-509`), i.e. viewer limits RPC +
   `plugin.update()`/`plugin.draw()` including all awaited round trips and the regular-table draw. The
   window is cleared on `visibilitychange`, and an in-flight sample spanning a visibility flip is
   discarded via an epoch counter (`render_timer.rs:37-44,159-168`). [src]
5. Then, unless a presize is pending (`dispatch.rs:488-498`, which just sets the stale flag), it
   dispatches `plugin.update` as in §3.3. [src]

So in adaptive mode the wait before each update-draw equals the recent mean draw duration.
[inf: restatement of 2–4; the resulting frame cadence is to be measured]

`viewer.getRenderStats()` exposes the timer: `{ render_times, total_render_count, total_time, virtual_fps, actual_fps }`
(`render_timer.rs:48-55,191-203`; `viewer.rs:1019-1024`), with `virtual_fps = 1000 / mean` and
`actual_fps = total_render_count / (total_time / 1000)`, counters reset on each call
(`render_timer.rs:92-93`). It returns nothing in constant-throttle mode (`render_timer.rs:87`). [src]

Related gates: auto-pause (default on) deletes the `ViewSubscription` when the element is not
intersecting or the document is hidden and re-renders on resume
(`rust/perspective-viewer/src/rust/tasks/auto_pause.rs:31-46`; `viewer.setAutoPause(false)` disables,
`viewer.rs:1772-1784`). [doc][src]

### 3.5 Updates faster than draws: conflated, queued or dropped?

- **Viewer level: conflated to at most one running + one parked draw.** [doc]
  `rust/perspective-viewer/src/rust/utils/debounce.rs:103-110` "An async `Mutex` type specialized for
  Perspective's rendering, which debounces calls in addition to providing exclusivity … At most TWO
  debounce evaluations are ever outstanding (one running, one parked); every additional concurrent
  caller resolves without queueing on the lock." Implementation `debounce.rs:189-223`:
  `if state.parked.get() { self.await_settled(next).await; return Ok(T::default()); } let settle = SettleGuard::park(state, next); let guard = self.mutex.0.mutex.lock().await; state.parked.set(false); let result = if state.last.get() < next { … f(RenderGuard { _private: () }).await … }`. [src]
- **No data is lost by the conflation**, because the viewer never consumes deltas: each executed draw
  re-reads the current window with `to_columns_string` (§2.3, §3.2 step 4). Intermediate values that
  were overwritten between two draws are never shown. [inf]
- **Engine level:** batches queue on the input port and are folded into the next process step (§3.1);
  notifications are one per port per step, not one per row or per `update()`. [src]
- **Not conflated:** the per-notification `view.dimensions()` RPC + status-bar stats (§3.2 step 5),
  and — over WebSocket to a Node server — one `ViewOnUpdateResp` frame per server process step. [inf]
- **regular-table level:** `draw()` goes through `throttle_tag`
  (`regular-table:src/ts/utils.ts:57-77`): a caller that arrives while a draw is in flight waits for it,
  and if yet another draw has started by then, waits for that and returns without drawing. [src]
- Pulse comparison uses the previous *draw's* values (`last_meta`), so conflated intermediate ticks do
  not flash individually. [inf from `data_listener/index.ts:455-467` + `cell_flash.ts:34-63`]

---

## 4. Scroll path

Scrolling is regular-table's own handler plus the §2.3 data listener and §2.5 style listeners. The
plugin registers **no scroll, wheel or `regular-table-scroll` listener** (`grep -rn "scroll"` over
`packages/viewer-datagrid/src/ts` finds only scroll-position resets, the scroll-lock toggle and
`scrollToCell` for keyboard navigation). [src] The viewer is not involved: no draw lock, no render
timer, no `plugin.*` call. [inf from the absence of any call from regular-table's scroll path into the
plugin element]

regular-table 0.9.2 scroll handler (`regular-table:src/ts/events.ts:50-52,60-97`):

- `this.addEventListener("scroll", this._on_scroll.bind(this), { passive: true });` [src]
- `_on_scroll`: records `scrollLeft`/`scrollTop`; if a scroll draw is pending just sets
  `_scroll_dirty = true` and returns; otherwise reads `this._table_clip.clientWidth/clientHeight` and
  `this.clientHeight`, then inside `throttle_tag`:
  `do { this._scroll_dirty = false; const commit = await this.predraw(width, height, { invalid_viewport: false, cache: true, throttle: false, container_height, scroll_left: this._scroll_left, scroll_top: this._scroll_top }); if (!commit.inline) { await new Promise(requestAnimationFrame); commit(); } } while (this._scroll_dirty);`
  and finally dispatches a `regular-table-scroll` event. [src]
  So it is **not** literally `_on_scroll → draw`: it is `_on_scroll → predraw (async fetch) → requestAnimationFrame → commit (sync DOM write)`,
  with intermediate scroll events coalesced by `_scroll_dirty`. `predraw` falls back to an inline
  `draw()` when row height or column widths for the target extent are not yet measured
  (`regular-table:src/ts/scroll_panel.ts:178-197,241-243`). [src]
- `predraw` with `cache: true` reuses the last `DataResponse` for dimensions (no probe call), computes
  the viewport, and — only if the integer row/column window changed (`invalid_row`/`invalid_column`,
  since `invalid_viewport: false`) — calls the data listener once:
  `regular-table:src/ts/scroll_panel.ts:276-281` `view_response = await this._view_cache.view(Math.floor(viewport.start_col), Math.floor(viewport.start_row), Math.ceil(viewport.end_col), Math.ceil(viewport.end_row));`
  (a second attempt happens if the row-header count differs from the plan, `:225,283-292`). [src]
  A scroll that stays within the same row only updates the sub-cell offset
  (`scroll_panel.ts:307-310` `this._update_sub_cell_offset(viewport); return true;`). [src]
- The commit closure runs `table_model.draw_sync(...)` and calls every style listener synchronously,
  un-awaited (`regular-table:src/ts/scroll_panel.ts:312-338`). If the pre-fetched slab did not fill the
  viewport it schedules a corrective full `this.draw({ invalid_viewport: true })` (`:352-354`). [src]

What the plugin contributes to the scroll path [src]

- `virtual_mode` (default `"both"`, §2.1) and `column_classes: true`.
- Sub-cell (pixel-smooth) scrolling is CSS in the plugin consuming variables regular-table sets:
  `packages/viewer-datagrid/src/css/sub-cell-scroll.css:16-25`
  `perspective-viewer-datagrid:not(.sub-cell-scroll-disabled) regular-table table … tbody td, thead th:not(.rt-group-corner) { transform: translate(var(--regular-table--transform-x, 0px)); } tbody { transform: translate(0, var(--regular-table--transform-y, 0px)); }`
  plus a `clip-path` on the first row (`:27-37`). The toolbar "scroll lock" toggles the class
  `sub-cell-scroll-disabled` (`model/toolbar.ts:98-110`), saved as `plugin_config.scroll_lock`
  (`plugin/save.ts:20`). [src]
- Row height: probe-measured, or pinned through `DataResponse.row_height` (§2.1).
- Column auto-size overrides: `reconcile_column_widths` runs inside every non-empty data-listener
  call (§2.4) and maps user column-resize overrides (stored by column path) onto regular-table's
  index-keyed `saveColumnSizes()`/`restoreColumnSizes()`; a capture-phase `mousedown` listener on
  `.rt-column-resize` persists widths on `mouseup` via `viewer.restore({ columns_config })`
  (`custom_elements/datagrid.ts:94-138,159-163`). `regular_table.resetAutoSize()` is called on config
  changes that alter columns/grouping/theme (`model/create.ts:254-261`, `plugin/draw.ts:53-57`). [src]
- Selection/edit hooks do not fire on scroll but their style passes run on every committed draw
  (§2.5): selection listener, tree-selection classes, focus restore (`applyFocusStyle`). Other
  listeners the plugin installs on the `<regular-table>` are input-only: `click` ×3, `mousedown` ×2
  (+ capture-phase command isolation for `pointerdown`/`mousedown`/`mouseup`/`dblclick`), `dblclick`,
  `pointerdown`, `focusin`, `focusout`, `keydown`, and selection `mousedown`/`mouseover`/`mouseup`
  (`plugin/activate.ts:155-244`, `commands.ts:270-275`, `event_handlers/select_region.ts:50-63`). [src]
  Keyboard navigation in edit mode calls `table.scrollToCell(x, y)` (`event_handlers/keydown/edit_keydown.ts:125`). [src]
- Per scroll-triggered fetch the listener still issues `to_columns_string` **and** `num_columns()`
  (§2.3) — two requests, both crossing the worker/WebSocket boundary. [src]

---

## 5. Config change (sort / group_by / filter through the viewer)

Entry: UI controls and `viewer.restore({...})` both go through the session op queue. The datagrid's own
header-click sort is literally `await viewer.restore({ sort }, { panel: model._panel });`
(`packages/viewer-datagrid/src/ts/event_handlers/sort.ts:54`). [src] Sequence for an edit
(`rust/perspective-viewer/src/rust/tasks/pipeline.rs:128-154`, then `locked_run`/`run_locked` `:231-350`):

1. **Main thread:** `session.check_edit(&update)?` (sync), `session.submit(OpKind::Edit{…})`. [src]
2. **Await (RPC → engine):** `prepare_edit` → `session.prepare_view(BindPlan::Keep, update, …)`
   (`tasks/transactional_restore.rs:146-164`), which validates the new config with the engine via
   `Table::describe` → `TableDescribeReq` (`rust/perspective-viewer/src/rust/session.rs:1172-1240`;
   `rust/perspective-client/src/rust/table.rs:824-832`). No view is created yet. [src]
3. **Main thread:** `commit_edit` commits the new config synchronously
   (`transactional_restore.rs:211-216`). [src]
4. **Await:** `render_run` → `locked_run` takes the per-panel draw lock
   (`pipeline.rs:237-240` `renderer.clone().render_task(|guard| run_locked(guard, session, renderer, spec))`).
   Any in-flight `update_lazy` draw finishes first. [src; ordering is [inf] from the shared mutex]
5. **`bind_snapshot`** (`pipeline.rs:33-50`): `snapshot` → `validate_snapshot` (memoized description,
   normally no RPC, `session.rs:1196-1205`) → `bind_view` (`session.rs:1509-1597`), which decides
   SKIP / REUSE / REBUILD by comparing the effective config with the one the bound view was built from
   (`session.rs:1543-1560`). For a real sort/group/filter change it REBUILDs: [src]
   - **Await (engine):** `let view = table.view(Some(view_config.into())).await?;` (`session.rs:1571`) →
     `TableMakeViewReq`; the engine builds the new context (sort/group/filter are computed here, in the
     worker or on the server). [src]
   - **Await:** `ViewSubscription::new(...)` → `view.on_update(...)` (`ViewOnUpdateReq`,
     `view_subscription.rs:160-165`; the send is awaited, there is no response to wait for) and a
     spawned `update_view_stats()` (`ViewDimensionsReq`, `view_subscription.rs:170`). [src]
   - **Old view deleted, not awaited:** `let old = self.borrow_mut().view_sub.take(); ApiFuture::spawn(old.delete());`
     (`session.rs:1588-1589`) → `view.remove_update(id)` then `view.delete()`
     (`view_subscription.rs:105-116`) → `ViewRemoveOnUpdateReq`, `ViewDeleteReq`. So the **new view is
     created before the old one is deleted**, and the delete races with the first draw of the new view. [src]
   - Returns `BindDisposition::Rebuilt(FreshView)` (`session.rs:1594`). [src]
6. **Main thread:** if plugin/column config changed or the plugin never drew: `plugin.restore(&plugin_update, Some(&columns_config))`
   (`pipeline.rs:312-323`). [src]
7. **Plugin draw:** `dispatch_bound` → `Rebuilt` → `renderer.draw_fresh` (`pipeline.rs:69-70`) →
   `draw_view(is_update = false)`: `view.dimensions()` (`dispatch.rs:542-545`), `view.schema()`
   (limits), then **`plugin.draw(view, max_cols, max_rows, false)`** (`dispatch.rs:573-574`), timed by
   `capture_time` (`dispatch.rs:421-426`). No throttle sleep on this path (the `set_timeout` is only in
   `update_lazy`). [src]
8. **Datagrid `draw`** (`plugin/draw.ts:20-66`): `activate(view)` → `viewer.getTable`, `createModel`
   (7 RPCs/calls, §2.1; also computes `_reset_scroll_top = group_by_changed`,
   `_reset_scroll_left = split_by_changed`, `_reset_select`, `_reset_column_size`,
   `model/create.ts:219-262`) → `setDataListener` → `this.regular_table.draw({ invalid_columns: true })`
   started, then synchronously `scrollTop = 0` / `scrollLeft = 0` / `psp-deselect-all` /
   `resetAutoSize()` as flagged, then `await drawPromise`. The first data-listener call sees
   `changed_cols` and adds `view.schema()` + `view.expression_schema()` (+ `column_paths` if split). [src]
9. `renderer.landed()`; the public promise (`viewer.restore(...)`) resolves at render completion
   (`pipeline.rs:113-116` [doc] "public mutators resolve at render completion"). [src]

Engine vs main thread: config validation, view construction (the actual sort/group/filter
computation), window serialization to JSON happen in the engine (worker or remote server). Config
diffing, protobuf encode/decode, `JSON.parse`, formatting, DOM and styling happen on the main thread.
[inf: summary of the cited steps]

When the new config is equal or engine-equivalent to the bound one, no view is built and the plugin
gets `update` (or nothing) instead of `draw` (`pipeline.rs:71-85`). [src]

Tree expand/collapse is not a config change: the plugin calls `model._view.collapse(meta.y)` /
`model._view.expand(meta.y)` / `model._view.set_depth(...)`, then `model._num_rows = await model._view.num_rows();`
and `regularTable.draw()` directly, bypassing the viewer's draw lock and throttle
(`packages/viewer-datagrid/src/ts/event_handlers/expand_collapse.ts:38-50`). [src]

---

## 6. Running it at 5.9.2

### 6(a) Engine in the page (worker), table from Arrow / JS rows

Minimal, from `examples/esbuild-example/src/index.js:13-38` [src]:

```javascript
import perspective from "@perspective-dev/client";
import perspective_viewer from "@perspective-dev/viewer";
import "@perspective-dev/viewer-datagrid";
import "@perspective-dev/viewer-charts";

import "@perspective-dev/viewer/dist/css/themes.css";
import "./index.css";

import arrow from "superstore-arrow/superstore.lz4.arrow";

import SERVER_WASM from "@perspective-dev/server/dist/wasm/perspective-server.wasm";
import CLIENT_WASM from "@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm";

await perspective_viewer.init({
    server: fetch(SERVER_WASM),
    viewer: fetch(CLIENT_WASM),
});

const req = fetch(arrow);
const viewer = document.createElement("perspective-viewer");
document.body.append(viewer);
const worker = await perspective.worker();
const resp = await req;
const buffer = await resp.arrayBuffer();
const table = worker.table(buffer);
viewer.load(table);
```

- JS rows work the same way: `worker.table(arrayOfObjects)` (stringified to JSON rows,
  `rust/perspective-js/src/rust/table_data.rs:145-147`) or `worker.table({col: [...]})`
  (`table_data.rs:74-78`); a schema object `{name: "string", …}` creates an empty typed table
  (`table_data.rs:72-73`), as `examples/trading-terminal/src/index.js:127-130` does:
  `const table = await worker.table(SCHEMA, { index: "symbol", name: TABLE_NAME });`. [src]
- `viewer.load()` accepts a `Table` (or promise of one) or a `Client` followed by
  `viewer.restore({ table: "name", … })` ([doc] `rust/perspective-viewer/src/rust/custom_elements/viewer.rs:505-544`;
  used in `examples/cdn/index.html:20-22`). [doc][src]
- `init` must register `viewer` before any `Client` exists from a `client` binary
  (`registry.ts:327-332` throws "viewer wasm must be registered before any Client is created from
  client wasm"). [src]
- The default plugin is the Datagrid ([doc] `custom_elements/datagrid.ts:204-206` "Higher priority than
  the chart plugins so the Datagrid is loaded by default."); import
  `@perspective-dev/viewer-datagrid` for it to exist. [src]

Bundler requirements for the WASM assets

- ESM builds need explicit bootstrapping: [doc] `docs/md/how_to/javascript/importing.md:10-17` "The
  recommended builds for production use are packaged as ES Modules and require a _bootstrapping_
  step in order to acquire the `.wasm` binaries … ESM builds must be _bootstrapped_ with their `.wasm`
  binaries to initialize."
- Two binaries for a page with a local engine: `@perspective-dev/server/dist/wasm/perspective-server.wasm`
  (engine; optional `perspective-server.memory64.wasm` as `server64`) and
  `@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm` (viewer + client)
  (`importing.md:24-30,46-61`). For a headless client only, `client: …/perspective-js.wasm`
  (`registry.ts:377-380`). [doc]
- esbuild: `loader: { ".wasm": "file" }` and pass `fetch(url)` (`examples/esbuild-example/build.js:24-28`;
  `importing.md:87-109`). [src][doc]
- Vite: import with `?url`, and `build: { target: "esnext" }`
  (`examples/vite-example/src/index.js:21-27`, `examples/vite-example/vite.config.js:15-19`;
  `importing.md:63-85`). [src][doc]
- Webpack: `type: "asset/resource"` for `.wasm`, `experiments.asyncWebAssembly: false`, and the URL
  strings are passed straight to `init` (`importing.md:111-140`; `examples/webpack-example/src/index.js`
  `await perspective_viewer.init({ server: SERVER_WASM, viewer: CLIENT_WASM,`). [doc][src]
- No bundler: the `dist/cdn/*.js` builds self-register defaults by URL relative to the module
  (`rust/perspective-js/src/ts/perspective.cdn.ts:18-31` `register_default({ client: () => fetch(new URL("../wasm/perspective-js.wasm", import.meta.url)), server32: …, server64: …, migrate: … })`),
  so `examples/cdn/index.html:9-22` needs no `init` call. [src]
- `init_server(wasm)` / `init_client(wasm)` still exist as wrappers over `init()`
  (`perspective.browser.ts:155-187,274-280`; viewer `bootstrap.ts:112-129`); the examples all use the
  single `perspective_viewer.init({ server, viewer })`. [src]
- The worker script itself needs no bundler configuration: it is inlined in the client bundle and
  started from a Blob URL (`tools/esbuild-plugin/worker.js:25-29,65-66`). [doc][src] A CSP that forbids
  `blob:` workers would hit the single-threaded fallback. [inf]
- All Perspective packages on a page must be the same release (`registry.ts:149-158` throws
  "Perspective X cannot share a page with Perspective Y"). [src]
- The published binaries are self-extracting ("stage 0") wrappers, decompressed at load
  (`registry.ts:190` `load_wasm_stage_0`; `disable_stage_0` option `registry.ts:69-71`). [src]

### 6(b) Host a table in Node.js and serve it over WebSocket

Package: `@perspective-dev/client` (Node build selected by the `"node"` export condition,
`rust/perspective-js/package.json` exports → `./dist/esm/perspective.node.js`; `engines.node >= 22`).
The package is ESM (`"type": "module"`) and `perspective.node.ts` uses top-level `await`
(`:81-85`, `:296`). [src] Use `import`; the `require(...)` in `docs/md/how_to/javascript/nodejs_server.md:12`
is unlikely to work as written. [inf: `require()` of an ES module with top-level await fails in Node]

In Node the engine is the same **WASM** build running **in the Node main thread**, exposed as a
module-level singleton — no worker: `perspective.node.ts:291-300`
`return await compile_server_module(resolve("@perspective-dev/server/dist/wasm/perspective-server.wasm")); … const SYNC_MODULE = await load_server_module(); … const SYNC_SERVER = new engine.PerspectiveServer(SYNC_MODULE);`
and `:313-315` `SYNC_CLIENT = new perspective_client.Client(async (req: Uint8Array) => { await SYNC_SESSION.handle_request(req); });`. [src]
[doc] `docs/md/how_to/javascript/worker.md:37-40` "The Node.js runtime for the `@perspective-dev/client`
module runs in-process by default". (Docs disagree with each other about Node being WASM vs native /
threaded: `docs/md/benchmarks.md:18` says "JavaScript (WebAssembly engine under Node.js)", while
`benchmarks.md:86-88` lists Node.js among builds that "use a thread pool", and the npm description
says "native in Node.js". The source loads the `.wasm`.)

API (exports of `perspective.node.ts`, `:621-639` default export
`{ table, join, websocket, worker, …, system_info, WebSocketServer, … }`, plus named `make_session`,
`make_client`, `PerspectiveServer`, `cwd_static_file_handler`): [src]

- `table(data, options)` → table on the singleton server (`:546-555`); `options.name` is the name
  browsers open.
- `new WebSocketServer({ port = 8080, assets = ["./"], server = undefined })` (`:442-501`): an
  `http` server that serves static files from `assets` and upgrades any path to WebSocket, using the
  `ws` package with **`perMessageDeflate: true`** (`:454-457`). Per connection:
  `const session = perspective_server.make_session(async (proto: Uint8Array) => { ws.send(buffer_to_arraybuffer(proto)); }); ws.on("message", (proto) => { session.handle_request(buffer_to_arraybuffer(proto)); }); ws.on("close", () => { session.close(); });`
  (`:459-474`). [src]
- `make_session(send_response)` for wiring your own transport (`:323-325`).

Shortest form, [doc] `docs/md/how_to/javascript/nodejs_server.md:11-23` (rewrite the `require` as `import`):

```javascript
const { WebSocketServer, table } = require("@perspective-dev/client");
const fs = require("fs");

// Start a WS/HTTP host on port 8080.  The `assets` property allows
// the `WebSocketServer()` to also serves the file structure rooted in this
// module's directory.
const host = new WebSocketServer({ assets: [__dirname], port: 8080 });

// Read an arrow file from the file system and host it as a named table.
const arr = fs.readFileSync(__dirname + "/superstore.lz4.arrow");
await table(arr, { name: "table_one" });
```

`examples/cdn/server.mjs:13-19` is the ESM version of the same thing:
`import { WebSocketServer } from "@perspective-dev/client"; … new WebSocketServer({ assets: [__dirname, "dist", "../../"] });` [src]

Hand-rolled transport, `examples/esbuild-remote/server/index.mjs:13,44-62` [src]:

```javascript
import { make_session } from "@perspective-dev/client";
…
const app = new HttpWebSocketServer({
    noServer: true,
    perMessageDeflate: true,
});

app.on("connection", async (ws) => {
    console.log("Connecting websocket ...");
    const session = await make_session(async (proto) => {
        ws.send(buffer_to_arraybuffer(proto));
    });

    ws.on("message", (proto) => {
        session.handle_request(buffer_to_arraybuffer(proto));
    });

    ws.on("close", () => {
        session.close();
    });
});
```

Browser side, `examples/esbuild-remote/client/index.js:36-50` [src]:

```javascript
const url = `${window.location.origin.replace("http", "ws")}/subscribe`;
const websocket = await perspective.websocket(url);

// Open a `Table` that is hosted on the server. All instructions
// will be proxied to the server `Table` - no calculations are
// done on the client.
const remote_table = await websocket.open_table("securities");
…
viewer.load(remote_table);
```

(`open_table`: `rust/perspective-js/src/rust/client.rs:488-490`.) This is "server-only" mode: every
datagrid draw and scroll fetch is a WebSocket round trip. The alternative "replicated" mode keeps a
copy in a browser worker: [doc] `docs/md/explanation/architecture/client_server.md:55-64`
`const server_view = await server_table.view(); const worker = await perspective.worker(); const client_table = await worker.table(server_view); … await viewer.load(client_table);`
— [doc] `:9-14` "web applications create duplicates of these tables in a local WebAssembly client in
the browser, synchonized efficiently to the server via Apache Arrow … browsers only need to download
the initial data set and subsequent update deltas, while operations like scrolling, pivots, sorting,
etc. are performed on the client." (`table(view)` is a derived table fed by the view,
`rust/perspective-js/src/rust/table_data.rs:48-56`.)

### 6(c) Streaming updates

- Anywhere you hold a `Table`: `table.update(rows | columns | arrowBuffer)`; with an `index` option the
  update replaces rows by key, with `limit` the table is a rolling window ([doc]
  `docs/md/use_cases/real_time_dashboard.md:105-108`). [doc]
- Node server, `examples/esbuild-remote/server/securities.mjs:86-102` [src]:

  ```javascript
  async function init_dynamic({ table_size, update_size, tick_rate }) {
      // Create a `table`.
      const table = await perspective.table(newRows(table_size), {
          limit: table_size,
          name: "securities",
      });
      …
      // Loop and update the `table` oocasionally.
      (function postRow() {
          table.update(newRows(update_size));
          setTimeout(postRow, tick_rate);
      })();
      return table;
  }
  ```

- In-page, `examples/trading-terminal/src/market.js:79-102` (`setInterval` → `await table.update(rows);`). [src]
- Nothing else is needed for the viewer to follow: it subscribes to `on_update` itself (§3.2). For
  your own consumers: `view.on_update((updated) => …, { mode: "row" })` delivers an Arrow delta
  ([doc] `rust/perspective-js/src/rust/view.rs:324-328`). [doc]
- [doc] `docs/md/integrations/kafka.md:58` "**Batch.** One `update()` of 500 rows is much cheaper than
  500 updates of …" (claim; measure).
- Python servers can opt into deferred processing with `Server(on_poll_request=…)`
  ([doc] `docs/md/how_to/python/multithreading.md:43-66`). The JS Node build has no public switch for it
  on the singleton, but `new PerspectiveServer({ on_poll_request })` + `server.poll()` and
  `new WebSocketServer({ server })` are exported (`perspective.node.ts:317-321,445-447`;
  `engine.ts:21-23,123-137`). [src]

### 6(d) `examples/` inventory

[src] for all rows (files under `examples/<name>/`); "data" is what the example loads. Superstore is the
`superstore-arrow` npm package; its row count is not stated in this repo. [inf: commonly ~10k rows, not verified here]

| example | shows | data | static / streaming | local / remote |
|---|---|---|---|---|
| `bundler-test` | type-check of published typings (`src/app.ts`), not a runnable demo | `"a,b\n1,2"` CSV | static | n/a |
| `cdn` | bundler-free page using `dist/cdn` builds + Node static host | Superstore Arrow | static (editable: `edit_mode: "EDIT"`) | local worker (the Node `WebSocketServer` is used only as a file server) |
| `esbuild-example` | esbuild bundling + `init({server, viewer})` | Superstore Arrow | static | local worker |
| `vite-example` | Vite bundling (`?url` imports, `target: "esnext"`) | Superstore Arrow | static | local worker |
| `webpack-example` | Webpack bundling (asset URLs passed to `init`) | Superstore Arrow | static | local worker |
| `react-example` | `@perspective-dev/react` `PerspectiveViewer` component | Superstore Arrow | static | local worker |
| `esbuild-remote` | Node-hosted streaming table, browser attaches over WebSocket | 10 000-row `limit` table, 50 rows per tick every 20 ms | streaming | remote (server-only) |
| `trading-terminal` | command-schema API across a 3-panel workspace (scatter, bar, datagrid) | 42 symbols, indexed on `symbol` | streaming, in page | local worker |
| `python-tornado` | Python server with three pages: `index.html` (server-only: `websocket.open_table("data_source_one")`, `:36-37`), `server_mode.html` (`websocket.table(arrow)`, `:33`), `client_server_editing.html` (worker table kept in sync with the server table through views, `:46-63`) | Superstore Arrow | static / editable | remote (server-only) or replicated, per page |
| `python-tornado-streaming` | Python streaming server with `on_poll_request` | `limit=250_000` table, 50 rows per 10 ms | streaming | remote (server-only) |
| `python-aiohttp` | aiohttp handler | Superstore Arrow, `index="Row ID"` | static / editable | remote |
| `python-starlette` | Starlette/FastAPI handler | Superstore Arrow, `index="Row ID"` | static / editable | remote |
| `rust-axum` | Rust native server via `perspective::axum::websocket_handler()` | Superstore Arrow | static | remote |
| `esbuild-duckdb-virtual` | virtual server over DuckDB-WASM in a worker (no Perspective table) | Superstore Arrow loaded into DuckDB | static | local (DuckDB worker) |
| `esbuild-clickhouse-virtual` | virtual server over ClickHouse web client in a worker | ClickHouse | static | remote DB |
| `python-duckdb-virtual` | Python `DuckDBVirtualServer` over Tornado | `superstore.parquet` | static | remote |
| `python-polars-virtual` | Python `PolarsVirtualServer` | `superstore.parquet` | static | remote |
| `python-clickhouse-virtual` | Python ClickHouse virtual server | ClickHouse | per its description "streaming" | remote |
| `python-postgres-virtual` | Python PostgreSQL virtual server | PostgreSQL | per its description "streaming" | remote |

`examples/README.md:3-13`: the examples are written to run inside the built source tree via
`pnpm run start $PROJECT_NAME` from the repo root. [doc] `examples/README.md:17-20` mentions a
`nodejs-virtual-server` example that does not exist at this tag. [src]

Detail on the requested ones

- **`trading-terminal`** [src]: `package.json` `"start": "node build.js && http-server dist"`. esbuild
  with `.wasm` as `file` (`build.js:24-28`). `src/index.js:115-138`: `init({server, viewer})`,
  `const worker = await perspective.worker();`, `worker.table(SCHEMA, { index: "symbol", name: "securities" })`,
  `await table.update(opening_rows());`, `await viewer.load(worker);`,
  `viewer.setCommandSchema(…, { scopes: ["context-menu", "datagrid-row", "chart-tooltip"] })`,
  `await viewer.restoreWorkspace(await WORKSPACE);`. The workspace (`src/layout.json`) has three panels
  on the same table: `scatter` (X/Y Scatter, `group_by: ["symbol"]`), `sectors` (Y Bar,
  `group_by: ["exchange","sector"]`, `split_by: ["exchange"]`) and `securities` (Datagrid,
  `group_by: ["sector","symbol"]`, columns `price, change, bid, ask, volume, last_updated`). Feed:
  `src/market.js:74-102` `start_market(table, { interval = 500, fraction = 0.7 })` — every 500 ms a
  random ~70 % of the 42 symbols (`src/symbols.json`) get a new quote, one `await table.update(rows)`
  per tick. So ~29 rows per update at 2 updates/s into a 42-row indexed table: a small, slow stream
  with a grouped datagrid, row-command buttons (`datagrid-row` scope → the command-block path in the
  data listener) and two charts sharing the worker. [src; the "~29" is 0.7 × 42]
- **`python-tornado-streaming`** [src]: `server.py:65-84` a thread creates a schema table
  `limit=250_000, name="data_source_one"` and loops `table.update(data_source(num_rows=50)); time.sleep(0.01)`.
  The server is built with `perspective.Server(on_poll_request=partial(on_poll_request, lock, executor))`
  (`:125-127`), where `on_poll_request` submits a `perspective_server.poll()` to a thread pool only if
  a lock is free (`:87-102` `if lock.acquire(blocking=False): executor.submit(poll_target, lock, perspective_server)`)
  — i.e. polls are skipped while one is running. [doc] `:94-99` "enables an optimization which can be
  applied in cases when deferring overlapping `Table.update` calls can be done safely … it is safe to
  defer these updates as they'll get applied when the next tick occurs." The WebSocket handler
  (`perspective.handlers.tornado.PerspectiveTornadoHandler`) receives binary frames and runs
  `session.handle_request(msg)` on the executor (`rust/perspective-python/perspective/handlers/tornado.py:185-192`),
  replying with `self.write_message(msg, binary=True)` (`:170-172`). The page (`index.html:26-56`)
  loads the `dist/cdn` builds from `/node_modules`, `perspective.websocket("ws://localhost:8080/websocket")`,
  `open_table("data_source_one")`, `viewer.load(table)`, then
  `viewer.restore({ plugin: "Datagrid", aggregates: { high: "avg", low: "avg" }, columns: ["high", "low"], group_by: ["client"], split_by: ["name"] })`
  — a pivoted (9 clients × 13 names × 2 columns) server-only grid. Native engine, Python process.
- **`esbuild-remote`** [src]: `package.json` `"start": "node build.js && node server/index.mjs"`; server on
  port 8081 (`server/index.mjs:104`). Data in `server/securities.mjs`: `TABLE_SIZE = 10000` (`:28`),
  `UPDATE_SIZE = 50` (`:22`), `TICK_RATE = 20` ms (`:25`), `CACHE_INPUT = false` (`:16`) → JS-row
  updates generated per tick (`:86-102`); a "fast mode" pre-generates 200 Arrow batches of 100 rows
  and replays them (`:109-137`). Columns: `name, client, lastUpdate, chg, bid, ask, vol` (`:73-81`).
  Client `client/index.js`: `init({ server: fetch(SERVER_WASM), viewer: fetch(CLIENT_WASM) })` (the
  server WASM is registered and fetched but no worker is created), `perspective.websocket(…/subscribe)`,
  `open_table("securities")`, `viewer.load(remote_table)`; a commented-out line shows the replicated
  alternative (`:44-47`). Flat (unpivoted) server-only datagrid at 50 updates/s of 50 rows.
  WebSocket frames are permessage-deflate compressed (`server/index.mjs:44-47`).
- **`vite-example`** [src]: `src/index.js:21-36` — `?url` WASM imports, `init`, `perspective.worker()`,
  `fetch("node_modules/superstore-arrow/superstore.lz4.arrow")`, `worker.table(buffer)`,
  `viewer.load(table)`; `vite.config.js` sets `build.target: "esnext"`. Static, local worker. No
  `package.json` description.
- **`esbuild-example`** [src]: quoted in 6(a). Static Superstore, local worker, esbuild `file` loader
  for `.wasm`/`.arrow`.
- **`cdn`** [src]: `index.html:5-7` preloads `perspective-server.memory64.wasm`,
  `perspective-viewer.wasm` and the Arrow file; imports the three `dist/cdn/*.js` builds and
  `dist/cdn/perspective.js` from `/node_modules`; `const worker = await perspective.worker(); … await worker.table(arrow, { name: "superstore" }); await viewer.load(worker); await viewer.restore({ table: "superstore", settings: true, plugin_config: { edit_mode: "EDIT" } });`
  (`:16-22`). Opens with the settings panel and edit mode on — both add per-draw work in the
  datagrid's style pass (§2.5); turn them off for a baseline. [inf] `server.mjs` only serves files.

---

## 7. Performance instrumentation and claims

Built-in instrumentation [src]

- **Viewer render timer:** `await viewer.getRenderStats()` → `{ render_times (≤5, ms), total_render_count, total_time, virtual_fps, actual_fps }`
  (§3.4). [doc] `viewer.rs:1010-1016` "… relative to the last time `getRenderStats` … `const {virtual_fps, actual_fps} = await viewer.getRenderStats();`".
  It times viewer-dispatched plugin draws/updates only — **scroll-driven regular-table draws are not
  included**. [inf from §4]
- **regular-table draw timer:** `DEBUG` is hard-coded `true` (`regular-table:src/ts/constants.ts:13`), so
  every `internal_draw` records `performance.now()` deltas (`regular-table:src/ts/scroll_panel.ts:984,1058-1060`)
  into a running average readable via `regularTable.getDrawFPS()` → `{ avg, real_fps, virtual_fps, num_frames, elapsed }`
  (`regular-table:src/ts/utils.ts:20-40`, `regular-table:src/ts/regular-table.ts:276-278`). Process-global
  (module-level `AVG`/`TOTAL`), reset on read. Only the `draw()` path is timed; **`predraw` + commit
  (the scroll path) is not** (no `log_perf` call in `predraw`). [src] Reach it with
  `viewer.querySelector("perspective-viewer-datagrid").regular_table.getDrawFPS()` (field
  `regular_table`, `custom_elements/datagrid.ts:63`). [inf]
- **Engine CPU time:** `await client.system_info()` → `{ heap_size, used_size, cpu_time, cpu_time_epoch, timestamp, client_heap?, client_used? }`
  (`rust/perspective-client/src/rust/client.rs:41-70`); the engine accumulates wall-clock ms around
  `handle_request` and `poll` (`server.cpp:1102,1155-1158,1174`). [doc] `client.rs:49-53` "Wall-clock time
  spent processing requests on the [`Server`], in milliseconds (estimated). This does not properly
  account for the internal thread pool". Works for worker and WebSocket clients alike.
- **No User Timing marks in normal operation.** The only `performance.mark`/`measure` calls are in the
  WASM `tracing` layer for spans (`rust/perspective-js/src/rust/utils/console_logger.rs:167-169,203`),
  and no code in `perspective-js`, `perspective-client`, `perspective-viewer` or `perspective-server`
  opens a span (`grep -rnE "span!\(|instrument\("` returns nothing). Log level is fixed at `WARN`
  (`console_logger.rs:129-134`), so the `tracing::debug!("SEND {}", msg)` / `"RECV {}"` lines
  (`perspective-client client.rs:326,452`) are compiled in but filtered. [src]
- **Async stack tagging:** viewer/client futures are wrapped in `console.createTask(name)` when
  available (`rust/perspective-js/src/rust/utils/futures.rs:42-62`), default label `"perspective"`
  (`futures.rs:99-101`), a few named ones such as `"resize-callback"` (`tasks/pipeline.rs:407` via `spawn_owned` → `ApiFuture::spawn_named`, `rust/perspective-viewer/src/rust/utils/spawn.rs:25-26`). These
  label async stacks in Chrome DevTools; they do not create trace events by themselves. [src][inf]
- **Build flags:** `PSP_DEBUG` disables minification of the JS bundles and worker
  (`tools/esbuild-plugin/worker.js:131`, `rust/perspective-js/build.mjs:22`) and builds the engine in
  debug (`rust/perspective-server/cpp/perspective/CMakeLists.txt:106,209`); `PSP_HEAP_INSTRUMENTS` builds
  heap-inspection tooling (`CMakeLists.txt:92,128-131`); cargo feature `trace-allocator` adds client heap
  numbers to `system_info` (`rust/perspective-viewer/Cargo.toml:41`). All require building from source. [src]
- **Benchmark suites** (`tools/bench/`, private package `@perspective-dev/bench`): `basic_suite.mjs`
  (`pnpm run bench_js`, engine under Node across released versions), `python_suite.mjs`,
  `charts_suite.mjs` (chart rendering in a browser via Playwright), `windows_suite.mjs`,
  `puppeteer_suite.mjs` (engine in a browser page), `remote_suite.js` (over `WebSocketServer`). Cases
  live in `cross_platform_suite.mjs`: [doc] `docs/md/benchmarks.md:48-57` table construction,
  `table.update(arrow)`, `view()` variants, `join()`, `to_arrow()/to_csv()/to_columns()/to_json()`; "A
  separate suite (`charts_suite.mjs`) measures chart rendering in a real browser." Results are Arrow
  files with `real_time, cpu_time, user_time, system_time` in microseconds (`benchmarks.md:21-29`).
  **There is no datagrid / DOM-rendering / scroll benchmark in the repo.** [src: no suite references
  `viewer-datagrid` or `regular-table`]

Claims in docs (quoted; none verified here)

- Virtual rendering: [doc] `docs/md/benchmarks.md:90-92` "**Rendering is separate from querying.** The
  data grid draws only the cells in view, so a grid over ten million rows renders in the same time as
  one over ten thousand; the query is what scales." [doc] `docs/md/glossary.md:12-13` "is
  _virtualized_: it renders only the visible cells, so its cost is independent of the number of
  rows." [doc] `docs/md/use_cases/large_datasets.md:21-24` "renders only visible cells, so scrolling a
  10 million row grid costs the same as scrolling a 100 row grid." [doc]
  `packages/viewer-datagrid/README.md:12-13` "Renders only the visible window of rows and columns, so
  grids over millions of rows scroll smoothly, including when the data lives on a remote server."
- Streaming: [doc] `docs/md/use_cases/real_time_dashboard.md:10-14` "`<perspective-viewer>` repaints
  only what changed. There is no polling and no query re-execution. An update of 50 rows to a 10
  million row table costs work proportional to the 50 rows." [doc] `docs/md/benchmarks.md:83-85`
  "**Updates scale with the delta.**" [doc] `packages/viewer-datagrid/README.md:16` "Live updates:
  cells repaint as the underlying `Table` streams."
  Source reading that bears on "repaints only what changed": on each update the datagrid refetches
  and re-renders the whole visible window through regular-table, and skips *restyling* of cells whose
  style inputs are unchanged (§2.3, §2.5); whether regular-table skips unchanged text writes was not
  traced. [src for the refetch/memo; the rest is open]
- Conflation: [doc] `docs/md/explanation/view.md:10` "(within a conflation window)"; [doc]
  `rust/perspective-server/src/server.rs:75` "This optimization allows batching updates".
- Throughput numbers: none stated for the datagrid or for updates/second. `docs/md/use_cases/ducklake.md`
  has timing tables, but for DuckDB-WASM virtual-server queries. [doc]
- Server-only latency: [doc] `docs/md/explanation/architecture/server_only.md:12-14` (quoted in §1.2).
- Engine threading: [doc] `docs/md/benchmarks.md:86-89` "**WebAssembly is single-threaded per worker;
  native is not.**"
- Browser support note: on a non-Chrome browser the client logs "Unknown browser detected. Some
  features may not work, and performance may be degraded." (`console_logger.rs:217-222`). [src]

---

## Could not determine

- Whether the decompressed inner WASM modules carry a `name` section (function names in Chrome CPU
  profiles); needs the extractor to be run.
- Whether regular-table 0.9.2 skips DOM text writes for cells whose value did not change between
  draws (regular-table's cell-write path was not read; only its call structure was followed).
- The actual batching ratio of the worker's 0 ms poll timer under load, and how the browser orders
  queued `message` tasks against that timer.
- Superstore row/column counts (not stated in this repo).
- Whether Node's engine uses more than one thread (docs conflict; source shows a WASM module
  instantiated in the main thread — no evidence of pthreads was looked for in the Emscripten build flags).
- Engine-internal cost structure of `to_columns` JSON serialization and of `_process` (C++ internals
  were followed only to the message/port/notify level).
- `viewer.getTable()` / `getEditPort()` exact RPCs issued during `createModel` (not traced into the
  viewer; `getEditPort` presumably maps to `TableMakePortReq` — [inf], unverified).

---

## Request/response timelines

### (i) One scroll step (local worker engine; window crosses a row boundary; columns unchanged; widths already measured)

1. **Main / browser** — `scroll` event on `<regular-table>` (passive listener). [src `regular-table:src/ts/events.ts:50-52`]
2. **Main / regular-table** — `_on_scroll`: record `scrollLeft/scrollTop`; if a scroll draw is pending,
   set `_scroll_dirty` and stop; else read `_table_clip.clientWidth/clientHeight`, `clientHeight`, enter
   `throttle_tag`. [src `regular-table:src/ts/events.ts:60-74`]
3. **Main / regular-table** — `predraw(width, height, { invalid_viewport: false, cache: true, throttle: false, … })`:
   reuse cached dimensions, compute viewport, decide `should_render`. [src `regular-table:src/ts/events.ts:77-84`, `regular-table:src/ts/scroll_panel.ts:194,229-259`]
4. **Main / datagrid** — data listener called with `(x0, y0, x1, y1)`; issues
   `Promise.all([view.to_columns_string({start_row: y0, start_col: x0, end_row: y1 (+1 if grouped), end_col: x1, id: true}), view.num_columns()])`. [src `regular-table:src/ts/scroll_panel.ts:276-281`; `packages/viewer-datagrid/src/ts/data_listener/index.ts:93-99,117-123`]
5. **Main / client WASM (in `perspective-viewer.wasm`)** — two requests built and prost-encoded
   (`ViewToColumnsStringReq`, `ViewDimensionsReq`), callbacks stored by `msg_id`. [src `rust/perspective-client/src/rust/view.rs:523-529`, `rust/perspective-js/src/rust/view.rs:433-437`, `rust/perspective-client/src/rust/client.rs:283-287,447-453`]
6. **Main → Worker** — two `port.postMessage(f, { transfer: [f] })` (remote: two binary `ws.send`). [src `rust/perspective-js/src/ts/wasm/browser.ts:101-104`; `rust/perspective-js/src/ts/websocket.ts:82-83`]
7. **Worker / JS host** — `handleMessage` → `SESSION.handle_request(new Uint8Array(msg.data))` → copy into
   engine heap → `_psp_handle_request` under `AsyncLock`. [src `rust/perspective-js/src/ts/perspective-server.worker.ts:45-46`; `rust/perspective-js/src/ts/wasm/engine.ts:154-170,209-226`]
8. **Worker / engine WASM** — `ProtoServer::handle_request`: `ParseFromArray` →
   `kViewToColumnsStringReq` → `view->to_columns(...)` → `set_json_string` → `SerializeAsString`
   (and `kViewDimensionsReq` for the other message). [src `rust/perspective-server/cpp/perspective/src/cpp/server.cpp:1099-1117,3556-3594`]
9. **Worker → Main** — `decode_api_responses` → `postMessage(f, { transfer: [f] })` per response; then
   `on_poll_request()` schedules/joins the 0 ms poll (no-op if nothing is dirty). [src `rust/perspective-js/src/ts/wasm/engine.ts:174-182,253-309`; `perspective-server.worker.ts:38-41`]
10. **Main / client WASM** — `port.onmessage` → `client.handle_response` → copy into WASM →
    `Response::decode` → remove `msg_id` from `subscriptions_once` → resolve; JSON `String` returned to
    JS. [src `rust/perspective-js/src/ts/wasm/browser.ts:112-114`; `rust/perspective-js/src/rust/client.rs:247-251`; `rust/perspective-client/src/rust/client.rs:324-331`]
11. **Main / datagrid** — `JSON.parse`, per-cell `format_cell` (`Intl` formatters), header formatting,
    width reconcile; return `DataResponse`. [src `packages/viewer-datagrid/src/ts/data_listener/index.ts:126,339-431,469-489`]
12. **Main / regular-table** — `predraw` returns the commit closure; `await new Promise(requestAnimationFrame)`. [src `regular-table:src/ts/events.ts:86-88`]
13. **Main / regular-table, in rAF** — `commit()`: `_commit_viewport`, `_update_virtual_panels`,
    `table_model.draw_sync(...)` (DOM writes), sub-cell offset. [src `regular-table:src/ts/scroll_panel.ts:297-338`]
14. **Main / datagrid, same task** — style listeners called synchronously: selection listener, then
    `consolidatedStyleListener` (`getMeta` per cell, memo-skip or restyle, header passes). [src `regular-table:src/ts/scroll_panel.ts:313-326`; `packages/viewer-datagrid/src/ts/plugin/activate.ts:156,164`; `packages/viewer-datagrid/src/ts/style_handlers/consolidated.ts:44-127`]
15. **Main / regular-table** — `_post_render`; loop again if `_scroll_dirty`; else release, dispatch
    `regular-table-scroll`. [src `regular-table:src/ts/scroll_panel.ts:340-346`; `regular-table:src/ts/events.ts:90-96`]
16. **Main / browser** — style recalc, layout, paint. [inf: standard pipeline; not in source]

Remote variant: hops 6–9 become WebSocket frames to the server process (Node: `ws.on("message")` →
`session.handle_request` → `_psp_handle_request` in the Node main thread → `ws.send`;
`rust/perspective-js/src/ts/perspective.node.ts:459-469`), everything else is unchanged. [src]

### (ii) One streaming update (local worker engine; producer on the main thread; datagrid visible; ungrouped)

1. **Main / app** — `table.update(rows)`. [src e.g. `examples/trading-terminal/src/market.js:97`]
2. **Main / client WASM** — `JSON.stringify(rows)` → `UpdateData::JsonRows` → `TableUpdateReq` →
   prost encode → `postMessage` (transfer). [src `rust/perspective-js/src/rust/table_data.rs:145-147`; `rust/perspective-client/src/rust/table.rs:810-820`; `rust/perspective-js/src/ts/wasm/browser.ts:101-104`]
3. **Worker / engine** — `_psp_handle_request` → `kTableUpdateReq`: parse rows, append to the input
   port, `mark_table_dirty`, reply `TableUpdateResp`. No view is updated yet. [src `rust/perspective-server/cpp/perspective/src/cpp/server.cpp:3053-3105`; `.../cpp/port.cpp:57-59`]
4. **Worker → Main** — `TableUpdateResp` posted; the app's `update()` promise resolves. [src `rust/perspective-js/src/ts/wasm/engine.ts:174-176`]
5. **Worker / JS host** — `on_poll_request()` → `PerspectivePollThread` arms `setTimeout(…)` (0 ms) unless
   one is already pending. Further `update()`s arriving before it fires just append (repeat 2–4). [src `rust/perspective-js/src/ts/wasm/engine.ts:59-85,178-179`]
6. **Worker / engine, timer task** — `server.poll()` → `_psp_poll` → `_poll()` →
   `_process_table_unchecked` → `t_update_task::run` → `g->process(port_id)` (views updated
   incrementally) → `_notify_table` builds one `ViewOnUpdateResp` per subscribed view (no delta for
   the viewer's subscription). [src `rust/perspective-js/src/ts/wasm/engine.ts:123-126`; `server.cpp:3945-3955,4088-4104,4210-4224`; `.../cpp/update_task.cpp:21-44`]
7. **Worker → Main** — `ViewOnUpdateResp` posted to the subscriber session. [src `rust/perspective-js/src/ts/wasm/engine.ts:128-134`; `perspective-server.worker.ts:38-41`]
8. **Main / client WASM** — `handle_response` → `msg_id` found in `subscriptions` → viewer's
   subscription callback → `LocalPollLoop` channel → `on_view_update`. [src `rust/perspective-client/src/rust/client.rs:334-338`; `rust/perspective-viewer/src/rust/session/view_subscription.rs:151-165`]
9. **Main ↔ Worker** — `view.dimensions()` round trip (stats). [src `view_subscription.rs:84`]
10. **Main / viewer WASM** — `on_stats.emit` (status bar), `table_updated.emit` → if plugin hidden: set
    stale flag and stop; else `renderer.update_lazy(...)`. [src `view_subscription.rs:98-99,69-74`; `rust/perspective-viewer/src/rust/tasks/create_panel.rs:61-80`]
11. **Main / viewer WASM** — `debounce_with`: coalesce onto a parked runner if one exists, else park and
    wait for the draw lock. [src `rust/perspective-viewer/src/rust/utils/debounce.rs:189-223`]
12. **Main / viewer WASM** — inside the lock: `set_timeout(timer.get_throttle())` (0 ms until 5 samples,
    then mean of last 5 draw times, cap 5000 ms; or the `setThrottle` constant). [src `rust/perspective-viewer/src/rust/renderer/dispatch.rs:487`; `renderer/render_timer.rs:110-122,146-150`]
13. **Main ↔ Worker** — `draw_view`: limits → `view.schema()` round trip. [src `rust/perspective-viewer/src/rust/renderer/limits.rs:73-75`; `dispatch.rs:547-549`]
14. **Main / datagrid** — `plugin.update(view, max_cols, max_rows, false)`: `view.num_rows()` round trip,
    then `regular_table.draw()`. [src `dispatch.rs:569-571`; `packages/viewer-datagrid/src/ts/custom_elements/datagrid.ts:247-267`]
15. **Main / regular-table** — `internal_draw`: dimension probe → data listener `(0,0,0,0)` →
    `view.num_columns()` round trip; viewport calc (reads `clientWidth/clientHeight`, `scrollTop/Left`). [src `regular-table:src/ts/scroll_panel.ts:986-1016`; `regular-table:src/ts/table.ts:700-703`; `packages/viewer-datagrid/src/ts/data_listener/index.ts:220-222`]
16. **Main ↔ Worker** — data listener for the window: `to_columns_string` + `num_columns()` round trips
    (as timeline (i) hops 4–10). [src `regular-table:src/ts/table.ts:723-728`; `data_listener/index.ts:117-123`]
17. **Main / datagrid** — `JSON.parse`, per-cell formatting, `DataResponse`. [src `data_listener/index.ts:126,339-431`]
18. **Main / regular-table** — render pass writes the DOM; at each `"style"` yield, style listeners are
    awaited: selection listener, `consolidatedStyleListener` (memo-skip per body cell; pulse animation
    if configured). [src `regular-table:src/ts/table.ts:742-750`; `regular-table:src/ts/scroll_panel.ts:1030-1042`; `packages/viewer-datagrid/src/ts/style_handlers/body.ts:332-343`]
19. **Main / viewer WASM** — `plugin.update` resolves; `capture_time` pushes the elapsed ms into the
    5-sample window; lock released; a parked runner (if any) starts at hop 12. [src `rust/perspective-viewer/src/rust/renderer/render_timer.rs:65-77`; `dispatch.rs:506-509`; `utils/debounce.rs:220-222`]
20. **Main / browser** — style recalc, layout, paint. [inf]

Remote variant (Node `WebSocketServer`, producer in the server process): hops 1–5 happen in the Node
process with no transport (`SYNC_CLIENT` → `SYNC_SESSION.handle_request`,
`rust/perspective-js/src/ts/perspective.node.ts:309-315`); the server runs in lazy mode, so each
`update()` is followed directly by `_psp_poll` (`engine.ts:180-181`) and hop 7 is a WebSocket frame per
subscribed browser view (`perspective.node.ts:461-465`). Hops 9, 13, 14, 15, 16 are each WebSocket
round trips. [src for the cited lines; the per-hop mapping is [inf]]
