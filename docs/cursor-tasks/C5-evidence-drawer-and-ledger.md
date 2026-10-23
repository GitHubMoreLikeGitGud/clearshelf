# C5: Evidence drawer, "why was this held?" trace and telemetry footer

## Goal

Every evidence chip in the UI opens a drawer that shows exactly where the claim came from, with the Lightning SQL text as the citation. "Why?" shows the ledger trace for a GTIN and market. The footer shows the model, measured tokens per second, peak VRAM, "0 cloud model calls" and the cold-versus-warm counts, and the card and recall watch show the flat tokens-per-chunk chart.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/meterless.mdc`, `.cursor/rules/data-licences.mdc`, `.cursor/rules/style.mdc`.
- `docs/api.md` (evidence, why, memory endpoints and the Run shape).
- `agent/src/evidence/store.ts` (`EvidenceRecord`, `LICENCES`), `agent/src/runtime.ts` (`whyTrace`), `agent/src/memory/hmemFacade.ts` (`WhyTrace`, `notesForTool`, the `kind:source_note` and `source:*` tags), `agent/src/memory/seed.ts` (how source-access memories are tagged), `agent/src/loop/telemetry.ts` (`ChartPoint`, `TelemetrySummary` and their labels), `agent/src/llm/ollama.ts` (`refusedModelHostAttempts`).
- The C4 UI: `ui/lib.js`, `ui/app.js`, `ui/views/card.js`, `ui/views/watch.js`, `ui/views/memory.js`, and the stubs `ui/views/evidence.js` and `ui/views/why.js` that this task replaces. Mount points: `[data-mount="token-chart"]` in the card and the watch, `<footer id="telemetry">` in `ui/index.html`.
- `agent/src/server.ts` and `agent/test/server.test.ts` (how endpoints and their tests are written).

## Inputs

An evidence record (one JSON line in `data/evidence/<runId>.jsonl`; all fields in `EvidenceRecord`):

```json
{"id":"ev-r20261023T130814d89f-07","run_id":"r20261023T130814d89f","kind":"zetaris_sql",
 "claim":"FDA H-1328-2026 reports UPC 816929000119 tested positive for undeclared milk",
 "template_id":"recalls_by_gtin","params":{"gtin":"0816929000119"},"sql":"SELECT ...","sql_sha256":"81c2...",
 "zetaris_object":"lightning.metastore.clearshelf.clearance_usl.fda_recall",
 "raw_objects":["clearshelf_fda.enforcement_undeclared"],
 "source_url":"https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000",
 "licence":"openFDA public domain / CC0; not endorsed by the FDA","queried_at":"...","source_cached_at":"...",
 "columns":["recall_number","..."],"rows":[["H-1328-2026","..."]],"row_count":1,"elapsed_ms":412,"cache_state":"hit",
 "model":{"name":"nemotron-3-nano:4b","think":false,"prompt_sha256":"...","tokens_in":1830,"tokens_out":212,"attempts":1,"eval_ms":1400,"tokens_per_s":151.4,"label":"measured"}}
```

Required fields per kind (render a missing one as "missing" in red): every record `id`, `run_id`, `kind`, `claim`, `queried_at`; `zetaris_sql` and `dq` also `sql`, `sql_sha256`, `zetaris_object`, `raw_objects`, `source_url`, `licence`, `source_cached_at`, `row_count`, `elapsed_ms`, `cache_state`; `dq` also `dq_source`; `model_extraction` also `model`.

The why trace is `GET /api/why/:gtin/:market`: `lines` (plain text, already ordered by the server) and `hmem` with `decision`, `conflicts`, `invariants` and `ledger: [{ memoryId, entries: [{ memoryId, action, actor, timestamp, details }] }]`.

## Deliverables

| File | Contents |
|---|---|
| `ui/views/evidence.js` | Replaces the C4 stub. `openEvidence(runId, ids)` fetches `/api/evidence/:runId/:id` for each id and shows the drawer; pure `renderEvidence(records): string`. Per record: the claim; kind; the Lightning SQL in a `<pre>` block with a Copy button (the SQL text is the citation); `sql_sha256`; template id and params; `columns` + up to 20 `rows` as a table with "N of row_count rows"; `zetaris_object`, `zetaris_objects` and `raw_objects`; `source_url` (a link, `rel="noreferrer"`) and `licence` exactly as stored, plus every entry of `sources`; `queried_at` and `source_cached_at` side by side with a plain line "source cached N minutes before the query", or "live read (ops table)" when every `raw_objects` entry starts with `clearshelf_ops.` (ops tables are never cached), else "cache time not recorded"; `cache_state`; `elapsed_ms`; for `dq` records "from Zetaris DQ" or "from DQ-equivalent SQL" (`dq_source`); for model records model name, think flag, tokens in/out, tokens/s and the label `measured`; `reused` and `derived_from` (each a chip that opens that record). An "Open in Zetaris" link to the GUI home page with the object path written next to it (see `docs/api.md`). |
| `ui/views/why.js` | Replaces the C4 stub. `openWhy(gtin, market)` and pure `renderWhy(trace): string`: the server's `lines` first (they hold the decision, its state and the replay label), then one time-ordered list merged from `hmem.ledger` entries and `hmem.conflicts` (conflict detected, conflict resolved with its rule label and reason, decision recorded, officer actions), each line with its time, actor and action, and a chip to its evidence or memory id. Officer actions name the officer. Title: "Why was this held?" for HOLD/BLOCK, otherwise "Why this decision?". |
| `ui/views/telemetry.js` | Pure `renderFooter(t): string` and `renderTokenChart(points, opts): string`, plus `mountFooter(el)` and `mountTokenCharts(root, ctx)`. The footer (from `GET /api/telemetry`): model name; planner tokens/s with its label; peak VRAM (whole-GPU used memory and the Ollama-reported model size, each labelled) or "not measured"; "0 cloud model calls" with the refused non-local attempts count; cold vs warm chunks and tokens with their labels, or "not measured". Refresh on `job.done`. The chart is inline SVG: the measured Markovian prompt tokens per chunk (solid line, label "Markovian prompt per chunk (measured)") against the naive full-history prompt (dashed line, label "full-history baseline (estimated, chars/4)"), with axes, chunk numbers and values; an empty series renders "no chart data". The card draws it from `run.loop.chart`; the watch draws one per sweep action from `GET /api/loops/:runId/:gtin/:market`. |
| `ui/views/memory.js` | Add the source-access memories panel from `GET /api/memory/sources` (id, content, provenance label, tags). Small change only. |
| `ui/app.js`, `ui/views/card.js`, `ui/views/watch.js` | Wire `mountFooter` and `mountTokenCharts`. Small changes only. |
| `ui/styles.css` | Append drawer, trace, chart and footer styles; do not restyle C4. |
| `agent/src/server.ts` | Three read-only GET endpoints, nothing else changed: **`/api/telemetry`** returns `{ model, model_host, cloud_model_calls: 0, refused_non_local_model_hosts: refusedModelHostAttempts(), planner_tokens_per_s: { value, label: "measured", runs } \| null` (median of `loop.summary.median_planner_tokens_per_s` over the newest 5 loop reports), `latest_loop: { file, run_id, gtin, market, chunks, chart, summary } \| null`, `vram` and `cold_warm` copied as stored from the newest `data/eval/*.json` that has them (else null), `eval_file` }`; **`/api/loops/:runId/:gtin/:market`** returns the loop report file `data/markovian/<runId>-<gtin>-<market>.loop.json` (else `<runId>.loop.json` when its gtin and market match; 404 otherwise; validate the run id with the existing `RUN_ID` pattern, the GTIN as 13 digits, the market as UK/US); **`/api/memory/sources`** (wired runtime only) returns `{ memories: [{ id, content, tags, label, learned_at }] }` for memory records tagged `kind:source_note` or tagged both `document` and `source:<x>`, without logging ledger reads. New `ServerDeps` fields `loopDir` and `evalDir` (default `data/markovian/` and `data/eval/`; null disables). |
| `docs/api.md` | Document the three endpoints in the read table. |
| `agent/test/evidence-render.test.ts` | Render tests for evidence, why and telemetry (see Checks). |
| `agent/test/server-telemetry.test.ts` | Endpoint tests with temporary directories and synthetic loop and eval files. |

## Constraints

- Escape every field before rendering; SQL, rows, claims, memory content and reasons are shown as text, never as HTML. URLs are shown only when they start with `https://` or `http://`, and are escaped in the attribute.
- Show a missing required field as "missing" in red rather than hiding it, so incomplete evidence is visible.
- The drawer, the trace and the footer read; they never write. The new endpoints are GET only and read files under the configured directories only (no path built from unvalidated input).
- Licence strings are shown exactly as stored.
- Every number keeps its label: `measured`, or `estimated (chars/4)` for the naive baseline and the carryover. A value that is absent is printed "not measured", never 0.
- Do not edit `engines/` or anything under `agent/src/` other than `server.ts`.

## Checks

- `cd agent && npx vitest run --maxWorkers=2` is green, including `evidence-render.test.ts`, which asserts: every required field of the record above appears in the rendered drawer; a missing required field renders as "missing"; a `<script>` inside a row value, the claim and the SQL is escaped; a `dq` record says which DQ source it came from; the why trace is in time order and names the officer on officer actions; the footer prints "not measured" for absent VRAM and cold/warm and keeps the labels; the chart labels both lines and handles an empty series; and `server-telemetry.test.ts`, which asserts the three endpoints' shapes, the 400 on a bad run id and the 404 on a missing loop report.
- `cd agent && npx tsc --noEmit` is clean.
- `node --check` passes for every `.js` file in `ui/`.
- The reviewer opens a drawer from a card claim and the "Why?" link on a held SKU in a real browser.

## Out of scope

Evidence storage, the ledger itself, the eval runner (C6), any write endpoint.

## Commit

`C5: evidence drawer, ledger trace and telemetry footer (Cursor Agent)`
