# Vendored upstream: Meterless reference engines

| Field | Value |
|---|---|
| Upstream repository | https://github.com/Meterless/Meterless |
| Commit | `1742dec56a66e58eef9dda2d2b865823758ca8cd` (committed 2026-10-19) |
| Licence | Apache-2.0. Each engine's `LICENSE` is kept next to it, unchanged. |
| Vendored | 2026-10-23 |
| Method | `git archive` of the paths below at that commit, raw blobs (no line-ending conversion). Nothing was edited. |

## Paths

| Engine | Vendored paths |
|---|---|
| H-MEM | `hmem/LICENSE`, `hmem/reference/`, `hmem/conformance/` |
| Markovian | `markovian/LICENSE`, `markovian/reference/`, `markovian/conformance/` |
| World Model | `world-model/LICENSE`, `world-model/reference/`, `world-model/conformance/`, `world-model/control-plane/` |

Not vendored: the engine specs (`AGENTS.md`), examples, docs and workshops. Links in the vendored READMEs to `../AGENTS.md` or `../examples/` resolve in the upstream repository.

## Rules

- Do not edit anything under `engines/`. ClearShelf extends the engines from `agent/src/` (for example a facade that subclasses `HMEM`).
- After `npm install` in a `reference/` folder, npm rewrites the root `"license"` field of that folder's `package-lock.json` (upstream's lock file says `MIT`; its `package.json` says `Apache-2.0`). Dependency resolution is unaffected. Restore the vendored file with `git checkout -- engines/<engine>/reference/package-lock.json`.
- To update: archive the same paths at a new upstream commit, rerun every check in `docs/conformance.md`, and update this file and `NOTICE`.

## Checking that the copy is unchanged

Compare blob ids between this repository and an upstream clone:

```bash
git ls-tree -r HEAD engines/hmem/reference          # in this repository
git ls-tree -r 1742dec56a66e58eef9dda2d2b865823758ca8cd engines/hmem/reference   # in the upstream clone
```

The blob ids must match file for file (same for every vendored path).
