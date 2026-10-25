#!/usr/bin/env bash
# Checks that engines/ is an unchanged copy of Meterless/Meterless at the commit in engines/UPSTREAM.md:
# every vendored file's git blob id must equal upstream's, with no file missing or added.
set -euo pipefail

UPSTREAM_URL="https://github.com/Meterless/Meterless.git"
COMMIT="1742dec56a66e58eef9dda2d2b865823758ca8cd"
PATHS=(
  engines/hmem/LICENSE engines/hmem/reference engines/hmem/conformance
  engines/markovian/LICENSE engines/markovian/reference engines/markovian/conformance
  engines/world-model/LICENSE engines/world-model/reference engines/world-model/conformance engines/world-model/control-plane
)

cd "$(git rev-parse --show-toplevel)"
git fetch --quiet --depth 1 --no-tags "$UPSTREAM_URL" "$COMMIT"
fetched="$(git rev-parse FETCH_HEAD)"
[ "$fetched" = "$COMMIT" ] || { echo "fetched $fetched, expected $COMMIT"; exit 1; }

ours="$(mktemp)"
theirs="$(mktemp)"
git ls-tree -r HEAD -- "${PATHS[@]}" | sort > "$ours"
git ls-tree -r "$COMMIT" -- "${PATHS[@]}" | sort > "$theirs"

extra="$(git ls-tree -r --name-only HEAD -- engines | grep -v -x -F -f <(cut -f2 "$ours") | grep -v -x 'engines/UPSTREAM.md' || true)"

n_ours="$(wc -l < "$ours" | tr -d ' ')"
n_theirs="$(wc -l < "$theirs" | tr -d ' ')"
if diff -u "$theirs" "$ours"; then
  same=yes
else
  same=no
fi
echo "upstream $COMMIT: $n_theirs files; this repository: $n_ours files; blob ids identical: $same"
if [ -n "$extra" ]; then
  echo "files under engines/ outside the vendored paths (only engines/UPSTREAM.md is expected):"
  echo "$extra"
  exit 1
fi
[ "$same" = yes ] && [ "$n_ours" -gt 0 ]
