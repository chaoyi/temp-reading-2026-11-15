// regular-table is served from its TypeScript source (shipped in the npm
// package under src/ts) instead of the minified dist build, so a trace's
// JavaScript samples show `_on_scroll` and `draw`, not `ie` and `$`. That
// source imports its stylesheet as text, which its own build does with a
// text loader; a virtual module does the same here. Perspective's datagrid
// bundles its own (minified) copy of regular-table; that copy is untouched.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const regularTableRoot = dirname(require.resolve("regular-table/package.json"));
const CSS_TEXT = "\0lab:regular-table-css:";

function readableRegularTable() {
  return {
    name: "lab-readable-regular-table",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith(".css") && importer?.startsWith(regularTableRoot))
        return CSS_TEXT + Buffer.from(resolve(dirname(importer), source)).toString("base64url");
    },
    load(id) {
      if (id.startsWith(CSS_TEXT))
        return "export default " + JSON.stringify(readFileSync(Buffer.from(id.slice(CSS_TEXT.length), "base64url").toString(), "utf8"));
    },
  };
}

// Every .html file in pages/ is an entry. The build is not minified and has
// source maps, so traces show real function names.
const pages = readdirSync(new URL("./pages/", import.meta.url)).filter((f) => f.endsWith(".html"));

export default defineConfig({
  root: "pages",
  base: "./",
  plugins: [readableRegularTable()],
  resolve: { alias: [{ find: /^regular-table$/, replacement: resolve(regularTableRoot, "src/ts/regular-table.ts") }] },
  optimizeDeps: { exclude: ["regular-table", "@perspective-dev/client", "@perspective-dev/viewer", "@perspective-dev/server", "@perspective-dev/viewer-datagrid"] },
  esbuild: { jsx: "automatic" },
  build: {
    target: "esnext",
    outDir: "../dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    modulePreload: false,
    rollupOptions: { input: Object.fromEntries(pages.map((f) => [f.replace(".html", ""), resolve("pages", f)])) },
  },
  worker: { format: "es" },
});
