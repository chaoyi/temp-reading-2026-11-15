#!/bin/sh
# Fetch and build the libraries' own examples at the pinned revisions into
# upstream/dist/, which the lab server serves under /upstream/.
#
#   regular-table v0.9.2            examples/ and benchmarks/, as shipped (they load /dist/…,
#                                   which the lab server maps to node_modules/regular-table/dist)
#   TanStack Virtual                examples/react/{fixed,dynamic,table}, built with Vite,
#   @tanstack/virtual-core@3.19.11  not minified, against the published packages
#
# Sources go to upstream/src/ (set RT_SRC / TV_SRC to use existing checkouts).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/src"; out="$here/dist"
mkdir -p "$src" "$out/regular-table" "$out/tanstack"

RT_SRC=${RT_SRC:-$src/regular-table}
if [ ! -d "$RT_SRC" ]; then git clone -q --depth 1 --branch v0.9.2 https://github.com/finos/regular-table.git "$RT_SRC"; fi
git -C "$RT_SRC" archive v0.9.2 examples benchmarks | tar -x -C "$out/regular-table"

TV_SRC=${TV_SRC:-$src/tanstack-virtual}
if [ ! -d "$TV_SRC" ]; then git clone -q --depth 1 --branch "@tanstack/virtual-core@3.19.11" https://github.com/TanStack/virtual.git "$TV_SRC"; fi
for ex in fixed dynamic table; do
  work="$src/build-$ex"
  rm -rf "$work"; mkdir -p "$work"
  cp -R "$TV_SRC/examples/react/$ex/." "$work/"
  # The dynamic example picks its view from location.pathname ("/", "/grid", …). Served
  # from a subdirectory that never matches, so the copy reads it from ?view= instead.
  if [ "$ex" = dynamic ]; then sed -i "s|const pathname = location.pathname|const pathname = '/' + (new URLSearchParams(location.search).get('view') ?? '')|" "$work/src/main.tsx"; fi
  ( cd "$work" && npm install --no-audit --no-fund --silent && npx vite build --base ./ --minify false --outDir "$out/tanstack/$ex" --emptyOutDir )
done
echo "upstream examples in $out"
