# ClearShelf agent API

The officer UI talks to the agent server (`agent/src/server.ts`, `npm run dev` in `agent/`) on `http://127.0.0.1:8790`. The server also serves the files in `ui/` (`/` is `ui/index.html`). This page is the contract the UI is built against; the TypeScript types named below are the exact shapes.

## Rules every client follows

- **Host.** The server answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise).
- **Writes.** Every `POST` carries `content-type: application/json` and a JSON object body (415 / 400 otherwise), and no foreign `Origin` (403 `origin`). A page served by the server itself passes these checks.
- **Errors.** Every error is `{ "error": "<message>", "code": "<code>" }` with a 4xx/5xx status. The UI shows `error` as text. A 403 is a refusal (no contract, bad signature, cross-origin) and is shown as a refusal, never retried. A 409 is a state conflict (`stale_proposal`, `stale_release`, `release_blocked`, `not_pending`).
- **Jobs.** Model work runs one job at a time. Endpoints that start one answer `202 { job_id }`; follow it with `GET /api/jobs/:id` or the `job.*` events.
- **The UI never decides.** CLEAR, CLEAR_WITH_STATEMENT and RELEASE run only through `POST /api/execute` with a contract from `POST /api/approvals/sign`. The UI forwards the contract it was given; it never builds, edits or signs one.
- **Replays.** Whenever `banner` is a string, the data comes from an as-of replay and the UI shows that banner. It is `"Replay as of 10 Oct 2026"` until a poll moves the as-of date on, then `"Replay from 10 Oct 2026, polled to 23 Oct 2026"`; the decision rows' reasons, the why trace, H-MEM and the World Model carry the same label.

## Read endpoints (GET)

| Path | Returns |
|---|---|
| `/api/health[?deep=1]` | `{ ok, service, model, gateway, watch: { mode: "off"\|"live"\|"replay", as_of, banner, busy }, jobs_pending, sse_listeners, gateway_health? }`. `model` is the local Ollama model name. |
| `/api/catalogue` | `{ source, banner, skus: [{ gtin, name, brand, markets, scenarios, decisions: { UK?: DecisionRow\|null, US?: … }, latest_runs: { UK?: runId\|null, … }, pending: [{ id, kind, market, status }] }] }` |
| `/api/sku/:gtin` (13 digits) | `{ gtin, sku, banner, markets: { UK?: { decision: DecisionRow\|null, run: Run\|null, pending: QueueItem[], label_checks }, US?: … } }`. `label_checks` is `{ text_field, keyword: [{ group, term, start, end }], traps: [{ group, term, start, end, reason }] } | null`: deterministic checks over the run's label text (the text in its `product` evidence record): what the keyword baseline flags (comparison only) and the verifier's trap readings, such as "cocoa butter is not milk fat". Offsets index that text. |
| `/api/runs/:runId` | `Run`: the full clearance result (see below). 404 when the run is not kept. |

`latest_runs` and `run` are the newest saved clearance of the SKU in that market, whichever path ran it: intake through this server, the command line (`npm run clear`), a recall-watch sweep or the scenario eval (`npm run eval`). `null` means the SKU has not been cleared in that market yet.
| `/api/evidence/:runId` | `{ run_id, records: EvidenceRecord[] }` |
| `/api/evidence/:runId/:evidenceId` | one `EvidenceRecord` |
| `/api/jobs/:jobId` | `Job`: `{ id, kind, state: queued\|running\|done\|failed, input, created_at, started_at, finished_at, result, error }` |
| `/api/approvals[?state=pending]` | `{ items: QueueItem[] }` (`agent/src/ops/queue.ts`): proposals (`kind: "proposal"`) and name-only matches (`kind: "name_match"`, with `notice_id`, `similarity`). |
| `/api/ops/decisions` | `{ rows, current: DecisionRow[] }`, the current decision per GTIN and market. |
| `/api/recheck` | the closed-loop recheck through Zetaris: `{ rows, sql, sql_sha256, objects, executed_at, elapsed_ms, cache_state }` |
| `/api/join-map` | the join map through Zetaris, same envelope as `/api/recheck`; rows are `{ transform, links, in_catalogue }` per GTIN transform (orphans = links − in_catalogue). |
| `/api/contracts/log[?limit=50]` | `{ entries }`, the contract verifier log (issued, verified, refused). |
| `/api/watch/state` | `{ state: WatchState\|null, banner, busy }` (`agent/src/watch/recallWatch.ts`) |
| `/api/watch/sweeps` | `{ sweeps: sweepId[] }`, newest first |
| `/api/watch/sweeps/:sweepId` | `SweepResult` (`agent/src/watch/recallWatch.ts`): `notices`, `exact_matches`, `name_matches`, `actions` (each with `status`, `rules`, `applied`, `decision_id`, `visible_in_zetaris`, `run_id`, `evidence_ids`), `recheck { rows, evidence_id }`, `checklist`, `gaps`, `model { calls, tokens_in, tokens_out, label }`, `replay`, `banner`, `window`. |
| `/api/why/:gtin/:market` | `{ lines: string[], hmem: WhyTrace, current: DecisionRow\|null, zetaris: rows\|null, citations: { prior_decisions: evidenceId\|null } }`. `lines` is the plain "why was this held?" trace; `hmem` (`agent/src/memory/hmemFacade.ts`) has `decision` (the decision-log entry, with `state` applied/proposed/not_applied and `replayAsOf`), `conflicts`, `invariants` and `ledger: [{ memoryId, entries: [{ memoryId, action, actor, timestamp (ms), details? }] }]` (officer reasons and rule labels are in `details`). The Zetaris read-back (`prior_decisions`) is cited like any other claim: an evidence record with its Lightning SQL, named in `citations.prior_decisions` and in the ops-store and prior_decisions lines; a re-opened trace with the same result reuses the record. An officer-signed decision carries its run, firings, policy evidence and the officer's reason (`decision.reason`, `decision.contractId`; `decision.releasedOver` lists the rules a RELEASE overrode). |
| `/api/memory/conflicts[?state=queued]` | `{ conflicts: (AllergenConflict & { product: { name, brand, markets }\|null, sides: { a, b } })[] }` (`agent/src/memory/allergenConflicts.ts`). Each side is `{ id, content, source, label, refs }`, read straight from the store (no ledger reads). |
| `/api/memory/dreams` | `{ proposals: InvariantProposal[], officer_rulings, runs_after }`; `officer_rulings` counts the separate officer actions in memory (dreaming needs two pointing the same way, and runs after each recall-watch sweep); `wording: { text, by, label }` says the wording is by Nemotron and derived from `derivedFrom` memories. |
| `/api/world/timeline/:gtin` | `{ gtin, timeline, snapshots }` |
| `/api/world/merges` | `{ proposals }`, the World Model merge queue |
| `/api/world/export` | the World Model graph |
| `/api/telemetry` | The footer figures, each copied from a measured file: `{ model, model_host, cloud_model_calls: 0, refused_non_local_model_hosts, planner_tokens_per_s: { value, label: "measured", runs } \| null, latest_loop: { file, run_id, gtin, market, chunks, chart, summary } \| null, vram \| null, cold_warm \| null, eval_file: { vram, cold_warm } }`. `planner_tokens_per_s` is the median of `loop.summary.median_planner_tokens_per_s` over the newest 5 loop reports in `data/markovian/` that have it; `latest_loop` is the newest loop report. `vram` is copied as stored from the newest `data/eval/*.json` with a `vram` object, and `cold_warm` from the newest one with a `cold_warm` key or the newest `cold-warm-*.json` measurement. A figure that was not measured is `null`, never 0. |
| `/api/eval/report` | `{ file: "docs/eval-report.md", updated_at, markdown }`: the measured evaluation report, for the UI's Evaluation page (`GET /eval` redirects to it). 404 when there is no report. |
| `/api/loops/:runId/:gtin/:market` | The loop report `data/markovian/<runId>-<gtin>-<market>.loop.json`, or `<runId>.loop.json` when its `gtin` and `market` match: `{ run_id, gtin, market, as_of, decision, rules, evidence_file, loop }`. The watch draws one tokens-per-chunk chart per sweep action from it (`runId` is the sweep id). 400 for a bad run id (`bad_id`), GTIN (`bad_gtin`) or market (`bad_market`); 404 when there is no such report. |
| `/api/memory/sources` | `{ memories: [{ id, content, tags, label, learned_at, superseded_by }] }`: the source-access memories (tagged `kind:source_note`, or tagged `document` and `source:<x>`), read straight from the store, so listing them logs no ledger reads. |

The memory, why, sources and World Model endpoints answer 404 `not_wired` on a server started without the runtime (tests).

### Run (a clearance result)

`ClearResult & { loop: LoopReport, saved }` (`agent/src/pipeline.ts`, `agent/src/loop/investigate.ts`, `agent/src/ops/runStore.ts`). The fields the card uses:

- `saved { source: "server"|"cli"|"watch"|"eval", applied: true|false|null, decision_id?, queue_id?, sweep_id?, replay?, note, at }`: where the run came from and what was done with its decision. `applied: false` with `source: "eval"` is an investigation that wrote nothing; the card says so next to the current decision.

- `run_id`, `gtin`, `market`, `as_of`, `product { found, name, brand, lang, has_text, text_field, labels }`. The ingredient text itself is not in the run: it is in the evidence record whose `template_id` is `product` (`columns` + `rows`).
- `decision` (`PolicyResult`, `agent/src/policy/decide.ts`): `status` (CLEAR, CLEAR_WITH_STATEMENT, HOLD, BLOCK), `firings` / `review` / `notes` (each `{ rule, effect, reason, evidenceIds }`), `autoExecutable`, `pendingSignature`, `policyVersion`.
- `statement { text, contains[], mayContain[], toConfirm[], excluded[] } | null`. `toConfirm` holds the contains-level allergens the deterministic verifier found that no verified span states (the model missed or contradicted them); `text` lists them under "Contains" marked "(to confirm)", so the draft never under-declares. Such a run is always held (R4), and `POST /api/approvals/sign` refuses a statement that still has "(to confirm)" in it (400 `unconfirmed_statement`). `claim_tests [{ claim, verdict, contradicting, evidenceIds }]` (verdicts SUPPORTED, PARTLY_SUPPORTED, NOT_SUPPORTED, UNTESTED), `contradictions [{ kind, text, evidenceIds }]`, `not_checked [{ id, text }]`, `card [{ text, evidenceIds }]` (every claim on the card with its evidence ids).
- `extraction { ran, reused, ok, spans, ungrounded, agreed, disagreed, verified: [{ group, relation, evidence_text, term, species? }], keyword_contains, model, wall_ms }`; the verifier record (`kind: "verifier"`) has `details.agreement: [{ group, relation, model, lexicon, agree, evidence_text }]`.
- `notices`, `name_matches`, `dq [{ rule, table, source, invalid, … }]`, `checklist`, `gaps`, `evidence_ids`, `quality { e_cov, claims, e_complete, records, incomplete_records }`.
- `loop`: `status`, `chunks`, `timeline [{ chunk, seq, source: model|fallback, tool, thought, fallback_reason, ok, fact, evidence_ids }]`, `chunk_telemetry`, `chart: [{ chunk, markovian_prompt_tokens_measured, markovian_prompt_tokens_estimated, naive_prompt_tokens_estimated, carryover_tokens_estimated }]`, `summary` (`TelemetrySummary`, `agent/src/loop/telemetry.ts`: planner calls, fallback steps, tokens with their labels, `median_planner_tokens_per_s`).

### EvidenceRecord

`agent/src/evidence/store.ts`. `id`, `run_id`, `kind` (zetaris_sql, model_extraction, verifier, memory, world_model, policy, dq), `claim`, `queried_at`; for Zetaris records `template_id`, `params`, `sql`, `sql_sha256`, `zetaris_object`, `zetaris_objects`, `raw_objects`, `source_url`, `licence`, `source_cached_at`, `sources [{ object, url, licence, cached_at }]`, `columns`, `rows` (at most 20), `row_count`, `elapsed_ms`, `cache_state`; `dq_source` (`zetaris_dq` or `dq_equivalent_sql`) on dq records. `source_cached_at` is when the gateway logged the source's CACHE TABLE; a table-wide DQ read over every Open Food Facts table carries the oldest CACHE time of those tables. It is `null` for records that read only ops tables (`raw_objects` all `clearshelf_ops.*`): those are never cached and are read live, so the drawer shows "live read (ops table)"; `model { name, think, prompt_sha256, tokens_in, tokens_out, attempts, eval_ms, tokens_per_s, label: "measured" }` on model records; `derived_from`, `reused`, `details`.

## Write endpoints (POST, JSON body)

| Path | Body | Reply |
|---|---|---|
| `/api/clear` | `{ gtin, market: "UK"\|"US", as_of? }` | `202 { job_id, state }`. The job result is `{ run_id, gtin, market, status, rules, banner, applied, decision_id?, contract_id?, visible_in_zetaris?, queue_id?, chunks, memory, world }`. HOLD/BLOCK are applied automatically; CLEAR proposals go to the approval queue. |
| `/api/approvals/sign` | `{ gtin, market, action: "CLEAR"\|"CLEAR_WITH_STATEMENT"\|"RELEASE", status?, statement?, reason, officer: "officer", queue_id? }` (`status` is required for RELEASE) | `{ contract, queue_id }`. 409 `stale_proposal` when a newer HOLD/BLOCK exists; 409 `release_blocked` with the blockers. |
| `/api/execute` | `{ gtin, market, status, statement?, action?: "RELEASE", reason, contract }` | `{ decision_id, contract_id, row, visible_in_zetaris, closed_loop_sql, recorded }`. 403 without a valid contract (logged, nothing written). |
| `/api/decisions` | `{ gtin, market, status: "HOLD"\|"BLOCK", reason }` | `{ decision_id, row, visible_in_zetaris, superseded }`. Any other status is refused with 403. |
| `/api/approvals/reject` | `{ queue_id, reason, officer: "officer" }` | rejecting a proposal holds the listing; rejecting a name match dismisses it. `{ item, decision_id?, visible_in_zetaris?, superseded? }` |
| `/api/approvals/confirm` | `{ queue_id, reason, officer: "officer" }` | confirms a name-only match: the listing is held (R2). |
| `/api/watch/replay` | `{ as_of, scope?: "scenario"\|"all"\|"none", poll?: boolean, until? }` | `202 { job_id, banner }`; job result `{ baseline, banner, actions, poll?, notices?, poll_actions?, name_matches? }` |
| `/api/watch/poll` | `{ until? }` | `202 { job_id }`; job result `{ sweep_id, banner, window, notices, exact_matches, name_matches, actions, recheck_rows, gaps }` |
| `/api/watch/live` | `{ since? }` | `{ state }`, leaves replay mode |
| `/api/memory/conflicts/resolve` | `{ id, winner, rule, reason, officer: "officer" }` | `202 { job_id }` (400 `bad_resolution` when the rule label or winner is not accepted) |
| `/api/memory/dreams/approve`, `/reject` | `{ id, reason, officer: "officer" }` | `{ id, memory? }` |
| `/api/world/merges/approve`, `/reject` | `{ id, officer: "officer", reason? }` | `{ id, reason }`; a reason is mined into H-MEM like every officer reason |

Every officer reason (approve, edit, reject, confirm, manual HOLD/BLOCK) is mined into H-MEM as a job and announced as `officer.reason` and `memory.officer_reason`.

## Server-sent events (`GET /api/events`)

One `EventSource('/api/events')` per page. Each event has an `id`, a `type` (the SSE event name) and a JSON `data` object that always includes `at`. A new connection receives only events from then on. On reconnect the browser sends `Last-Event-ID` and the server replays the events after it that it still holds (the last 500); `?since=<id>` does the same on a fresh connection.

| Event | Data (main fields) |
|---|---|
| `job.queued`, `job.started`, `job.done`, `job.failed` | `job_id`, `kind`, `input` / `result` / `error` |
| `clear.started`, `clear.log`, `clear.done` | `gtin`, `market`, `run_id`, `line` (log), `banner` |
| `loop.chunk_start` | `gtin`, `market`, `run_id`, `chunk`, `carryover_tokens` |
| `loop.planner` | `chunk`, `call`, `valid`, `attempts`, `tool`, `thought`, `prompt_tokens`, `eval_tokens` (measured) |
| `loop.tool` | `chunk`, `seq`, `tool`, `source` (model or fallback), `fallback_reason`, `ok`, `fact`, `evidence_ids`, `latency_ms` |
| `loop.chunk_end` | `chunk`, `state_tokens`, `complete` |
| `decision.written` | `gtin`, `market`, `status`, `auto`, `decision_id`, `visible_in_zetaris` |
| `approval.queued`, `approval.resolved`, `approval.superseded` | `gtin`, `market`, `queue_id` / `queue_ids` |
| `contract.signed`, `contract.refused` | `contract_id` / `code`, `reason`, `action` |
| `memory.recorded`, `memory.officer_reason`, `memory.conflict_resolved`, `memory.dream_approved`, `memory.dream_rejected`, `memory.dreamed` | ids of the memories, conflicts or proposals |
| `world.recorded`, `world.merge_resolved`, `world.fsa_ingested` | snapshot and event ids |
| `officer.reason` | `kind`, `gtin`, `market`, `reason` |
| `watch.state`, `watch.sweep_started`, `watch.notice`, `watch.exact_match`, `watch.name_match`, `watch.clear_started`, `watch.action`, `watch.approval_queued`, `watch.approval_superseded`, `watch.recheck`, `watch.world`, `watch.feeds_refresh`, `watch.sweep_done` | the sweep's progress; `watch.sweep_done` carries the `sweep_id` |

Intake progress maps the `loop.tool` tool names to the stages shown to the officer: `registrar.register_off` registering in Zetaris; `zetaris.product`, `zetaris.declared`, `zetaris.recalls_by_gtin`, `zetaris.recalls_by_name`, `zetaris.market_list`, `world.lookup` fetching; `extract.ingredients`, `extract.notice` reading; `zetaris.dq_gate`, `memory.recall` verifying; `policy.propose` deciding.

## Zetaris links

The Zetaris GUI runs at `http://localhost:3000/` (login required). Deep links to the Data Explorer and the `clearance_usl` ERD are not known; the UI links the home page with the path written next to it: Data Explorer, Lightning databases `CLEARSHELF_*`; USL `lightning.metastore.clearshelf.clearance_usl`, ERD view.
