# Meterless conformance results

Run on 2026-10-23 against the engines vendored in `engines/` (upstream `Meterless/Meterless` commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, see `engines/UPSTREAM.md`). Windows 11, Node v22.13.1, npm 10.9.2. Each engine was installed with `npm install` in its `reference/` folder, then run exactly as its README says.

## Summary

| Check | Command (working directory) | Result | Exit code |
|---|---|---|---|
| H-MEM conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/hmem/reference`) | **13/13 passed** | 0 |
| Markovian conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/markovian/reference`) | **8/8 passed** | 0 |
| World Model conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/world-model/reference`) | **8/8 passed** | 0 |
| World Model idempotency check | `npx tsx scripts/idempotency-check.ts` (`engines/world-model/reference`) | **diff: empty** (pass) | 0 |
| World Model idempotency check, negative control | `npx tsx scripts/idempotency-check.ts --mutate` | diff: NON-EMPTY, as expected (shows the check can fail) | 0 |
| H-MEM smoke tests | `npm test` (`engines/hmem/reference`) | 10/10 passed | 0 |
| Markovian smoke tests | `npm test` (`engines/markovian/reference`) | 10/10 passed | 0 |
| World Model smoke tests | `npm test` (`engines/world-model/reference`) | 10/10 passed | 0 |
| Markovian measured run | `npx tsx scripts/measured-run.ts` (`engines/markovian/reference`) | completed; output below | 0 |
| **H-MEM conformance, ClearShelf facade** (2026-10-23, Day 2) | `HMEM_IMPL=<repo>/agent/src/memory/hmemFacade.ts npx tsx ../engines/hmem/conformance/runner.ts` (`agent`) | **13/13 passed** | 0 |
| **World Model idempotency, ClearShelf catalogue** (Day 2) | `npx vitest run test/world-idempotency.test.ts` (`agent`) | **8/8 passed**, including the empty-diff re-ingest | 0 |
| **World Model idempotency, live Zetaris rows** (Day 2) | `npx tsx src/world/liveIdempotency.ts --fsa-since 2026-09-01` (`agent`, gateway running) | **diff: empty**; numbers below | 0 |

The vendored reference suites were run again on Day 2 after the ClearShelf extensions were added: H-MEM 13/13, World Model 8/8, World Model idempotency check `diff: empty`. `git status engines/` was clean, so the extensions changed nothing under `engines/`.

## Details

### H-MEM (13 checks)

| Group | Checks |
|---|---|
| record-validation | rv-001, rv-002 |
| feedback-deltas | fd-001 to fd-005 |
| ranking-order | ro-001, ro-002 |
| sleep-guardrails | sg-001 |
| conflict-gate | cg-001 |
| ledger-audit | la-001 |
| dream-boundary | db-001 |

All PASS.

### Markovian (8 checks)

eff-001, snap-001, snap-002, ovl-001, lab-001, ref-001, mrk-001, cfg-001. All PASS.

### World Model (8 checks)

sid-001, sid-002, band-001, prov-001, idem-001, idem-002, bitemp-001, audit-001. All PASS.

### World Model idempotency check output

```
run 1: processed=3 clusters=1 changed=true
run 2: processed=0 skipped=3 changed=false
diff: empty
```

With `--mutate`:

```
run 1: processed=3 clusters=1 changed=true
run 2: processed=1 skipped=2 changed=true
diff: NON-EMPTY
```

The script prints the verdict and exits 0 in both modes; the pass criterion is the `diff:` line.

### H-MEM facade (`agent/src/memory/hmemFacade.ts`)

The facade exports `HMEM`, a subclass of the vendored reference class; the engine's own runner loads it through `HMEM_IMPL`. Scorecard (Day 2):

```
H-MEM conformance: implementation = agent/src/memory/hmemFacade.ts
  record-validation   PASS rv-001, rv-002
  feedback-deltas     PASS fd-001 to fd-005
  ranking-order       PASS ro-001, ro-002
  sleep-guardrails    PASS sg-001
  conflict-gate       PASS cg-001
  ledger-audit        PASS la-001
  dream-boundary      PASS db-001
  13/13 checks passed
```

What the subclass adds, and how each addition keeps the reference contract:

| Addition | Contract kept |
|---|---|
| `addFact()`: facts with `source: "zetaris:<object>"`, provenance origin `document` (source rows) or `plan_completion` (derived), `refs [evidenceId, sqlSha256]`, tags `gtin:`, `brand:`, `allergen:`, `polarity:`, `notice:`. A repeated fact is reconfirmed (refs merged, one `update` entry), never duplicated. | Writes go through `store.add` / `store.update`, so every one has a ledger entry; plain `add()` is not overridden. |
| `allergenConflicts.ts`: contains or may-contain against free-from on the same GTIN, or the same brand when one side has no GTIN. Logged as `conflict_detected` on both memories, scored per side (source class, confidence, record date, safe direction), and **always queued**. | The reference `conflicts.scan()` still runs (`nativeScan()`); pairs that touch an allergen fact, an officer ruling or a decision are never passed to `autoResolve`. Resolution sets `supersededBy` through `store.update` and logs `conflict_resolved` with actor `officer` and a rule label; nothing is deleted. |
| Officer reasons (`officerAction`): mined with the reference `user_correction` contract (same prompt, parser and model-free fallback), written with actor `officer`, scoped by brand or GTIN. | The reference fixes the actor at construction; `withActor()` switches it for one synchronous block and restores it, and fails loudly if the reference field disappears. |
| Dreaming (`dream`, `approveDream`, `rejectDream`): the reference `dream()` proposes; invariant proposals resting on two or more officer actions are queued, worded in one sentence by Nemotron, and persisted. | Nothing materialises before approval; approval writes a `long_term` memory with `derivedFrom` lineage and a `dream_approved` ledger entry. An approved invariant can only escalate a decision (`escalationsFor` feeds the policy's `escalations`). |
| `why(gtin, market)`: the decision log merged with `ledger.history()` of the decision, the facts it rests on and its conflicts. | Read-only. |
| Persistence in `data/hmem/` (gitignored): `state.json`, `ledger.jsonl` (reference) plus `allergen_conflicts.json`, `dream_queue.json`, `decisions.jsonl`, `seed.json`. | The reference files are written only by the reference code. |

Tests: `agent/test/memory-facade.test.ts`, 19 cases (synthetic data), all passing.

#### First-boot seed (2026-10-23, 13:18 SGT)

`npx tsx src/memory/seed.ts` (`agent`, with `ZETARIS_GETTING_STARTED_DIR` pointing at the Zetaris getting-started repository) seeded `data/hmem` with 75 memories, every one with provenance origin `document`: 23 source facts parsed from `open_data/manifest.json`, 41 statements mined by `nemotron-3-nano:4b` from the 7 `known_to_fail/ISSUE*.md` files, and 11 measured ClearShelf source findings (`docs/source-notes.md` does not exist yet; the findings in `seed.ts` stand in for it). The 7 miner calls returned a valid JSON array on the first attempt (7/7), 8 statements each; 15 of the 56 were dropped by the grounding check because a URL, number or unit in them was not in the document verbatim, or they were authorship lines. Measured per call: prompt 1,828 to 2,493 tokens, output 156 to 224 tokens, 157 to 162 tok/s, 1.3 to 1.7 s. A second run skips every document.

### World Model catalogue (`agent/src/world/world.ts`, `match.ts`)

`CatalogueWorld` wraps the reference `WorldModel` (`storage: "local"`, namespace `clearshelf`, directory `data/world`, `conflictPolicy: "most-recent-wins"`). Every write's `at` is the source record's date (OFF `last_modified`, FDA `report_date`, FSA `created`, decision time), never the retrieval time. Re-ingesting unchanged rows is checked against the entity, edge and fact already in the graph and writes nothing, so both the canonical state and the event log stay the same.

Three rulings on top of the reference, all made in `agent/src/`:
- The reference closes an open edge when a new edge has the same `(from, type, context)` and another target (single-valued relations). Multi-valued relations (`declares`, `made_by`, `concerns`, `reports`, `listed_in`, `name_match`) use a per-target context `<scope>#<key>`, so a product that declares milk and egg keeps both edges open.
- An edge the source no longer lists, or whose attributes change, is closed by relating its context to the target `retracted` at the new source time. `retracted` is never an entity, so graph views never return it, and the closed edge stays in the history.
- The reference has no `snapshot()` write. `recordDecision()` writes the decision entity, the `decides` edge, `assertFact(product, "clearance:<market>", status)`, the listing status, and a snapshot in `data/world/snapshots.jsonl` (event sequence number and state hash included). `knewWhen()` answers from the snapshots (when the agent knew it); `asOf()` answers from source time.

Name matching (`match.ts`): a brand-token pre-filter (legal forms and generic trade words such as "foods" are not distinctive), then the reference `nameSimilarity` against every alias of the brand, then the reference bands: at least 0.85 auto-links, 0.82 to 0.85 is upserted as a brand so the reference resolver queues it in `mergeQueue()` for `approveMerge`. Every match is a `name_match` edge (a review item); none changes a listing status.

#### Live idempotency on Zetaris rows (2026-10-23, 13:24 SGT)

`agent/src/world/liveIdempotency.ts` reads the 30 demo SKUs (product, declared, recalls_by_gtin) and the FSA alerts created since 2026-09-01 (fsa_recent, fsa_allergens) through the gateway, ingests them, reads them all again, ingests again, then reloads the graph from disk and ingests a third time. All reads hit the Zetaris cache; no source was called.

```
read 1: 30 products, 9 FSA alerts, 99 template calls, 152540 ms; missing []
ingest 1: appended 378 events (0 -> 378), state changed true, writes {"entities":119,"edges":259,"retractions":0,"kept":174}
read 2: 30 products, 9 FSA alerts, 99 template calls, 136154 ms
ingest 2: appended 0 events, state changed false, writes {"entities":0,"edges":0,"retractions":0,"kept":552}
ingest 3 (fresh process state from disk): appended 0 events, state changed false
entities {"allergen":15,"brand":28,"firm":21,"market":2,"notice":23,"product":30}
open edges {"listed_in":33,"reports":42,"name_match":5,"concerns":14,"declares":111,"made_by":31,"issued_by":23}
name matches: FSA-AA-41-2026->5000169566558 auto-link 1; FSA-AA-44-2026->4006894512205 auto-link 1; FSA-AA-44-2026->4006894554106 auto-link 1;
              FSA-AA-45-2026->5056315500204 auto-link 1; FSA-AA-45-2026-update-1->5056315500204 auto-link 1
merge queue: empty
state sha256 644dac062313ce6a2286a4e7300a68b8eb6f11a03763c307b34106249e501222
diff: empty
```

An earlier run of the same check (before "foods" became a non-distinctive token) also gave `diff: empty`; it had three more token-only matches of "... Foods Limited" against Whole Foods Market, which is why the token was dropped. All timings are measured wall time.

Tests: `agent/test/world-idempotency.test.ts` (8) and `agent/test/world-match.test.ts` (7), synthetic rows shaped like the gateway templates, all passing. The idempotency cases: same rows twice (0 events appended, same state hash), reload from disk then the same rows (0 events), a changed recall status (state changes, negative control), multi-valued edges all open, a dropped declaration closed at the new source time with its history kept, and no write dated from the clock.

### Markovian measured run

This is the engine's own demonstration with its mock generator, not a ClearShelf measurement. Every number is labelled by the script as estimated (chars/4).

| Step | Naive cumulative input tokens | Markovian cumulative input tokens | Ratio |
|---|---|---|---|
| 1 | 29 | 112 | 0.26x |
| 10 | 13,213 | 1,381 | 9.57x |
| 20 | 55,358 | 2,801 | 19.76x |

Input tokens saved at step 20: 52,557 (94.9%, estimated).

## Notes

- `npm install` rewrites the root `"license"` field in each vendored `package-lock.json` (upstream lock says `MIT`, `package.json` says `Apache-2.0`). The vendored lock files were restored to the upstream bytes before these runs; dependency resolution is the same either way.
