# C6: Evaluation runner and report

## Goal

`npm run eval` runs the scenario set (E1 to E10), the extraction evaluation over the manifest SKUs with reference labels, the evidence-quality scoring and the cold-versus-warm run; writes one `data/eval/eval-<timestamp>.json`; and renders `docs/eval-report.md` from it with measured numbers only, each labelled.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc` (integrity and labels), `.cursor/rules/data-licences.mdc` ("reference labels"; no Open Food Facts text in committed files), `.cursor/rules/style.mdc`.
- `agent/src/eval/run.ts` and `agent/src/eval/scenarios.json`: the scenario runner that exists today (E1 to E10 through the wired runtime; E8 synthetic behind an in-process fake gateway; E2 read from the replay sweeps). Extend it; keep what works.
- `agent/src/runtime.ts` (`openRuntime`, `investigate`), `agent/src/loop/investigate.ts` (`LoopReport`), `agent/src/loop/telemetry.ts` (summary fields and labels), `agent/src/pipeline.ts` (`ClearResult`, how the ingredient text is chosen: `ingredients_text`, else `ingredients_text_en`), `agent/src/extract/ingredients.ts` (`extractIngredients`, `verifiedAllergens`), `agent/src/verify/lexicon.ts` (`keywordBaseline`, `verifySpans`) and `agent/src/verify/lexicon.data.ts` (`TRAP_TERMS` and their groups), `agent/src/evidence/store.ts`, `agent/src/zetaris/client.ts` (`GatewayClient.template`, `rowsAsObjects`), `agent/src/llm/ollama.ts` (`OllamaClient`, `loaded()`), `agent/src/contract/scout.ts` and `agent/src/ops/store.ts` (decision rows, the contract verifier log), `agent/src/cli.ts`.
- `data/manifest/skus.json`: `label_rules` (the documented rules), and per SKU `reference_labels.label_text` (per group `contains`, `may_contain`, `none` or `unscored`), `reference_labels.in_extraction_eval`, `reference_labels.traps_present`, `off_snapshot.lang`, `display_name`, `role`. Read the labels and the rule texts only; do not open `scripts/curate-manifest.ts` (the labelling code must stay independent of what it is scored against).

## Inputs

### Scenarios (`agent/src/eval/scenarios.json`, already filled)

E1 to E10 as in SPEC 9.1, with the manifest picks filled. **E2 expects HOLD after the poll, not BLOCK** (decision of 2026-10-23): a US-only recall of the same GTIN keeps a UK listing at HOLD under R1. Its `spec_note` gives the reason; the report prints every scenario's `spec_note` next to its row. Scenario assertions test the rules that fired and the evidence; when a live recall status moved, the report says so rather than changing the expectation.

### Extraction evaluation

- SKUs: every manifest SKU with `reference_labels.in_extraction_eval: true`, in its first market. The text is read only through the gateway (`product` template, `ingredients_text` else `ingredients_text_en`). A SKU whose product row is not in Zetaris (the `eval_only` SKUs may not be registered yet) is listed as "not measured: no product row in Zetaris" and left out of every denominator.
- Reference labels: `reference_labels.label_text`, per group. `unscored` pairs are left out. Always call them "reference labels".
- Systems, each mapped to one label per group (`contains` beats `may_contain` beats `none`):
  - **K**: `keywordBaseline(text)`; every hit group is `contains` (it has no precautionary reading).
  - **N**: Nemotron alone: the grounded spans of `extractIngredients(text, ollama)` with relation `contains` or `may_contain`.
  - **N+V**: the spans the lexicon verifier agrees with (`verifiedAllergens(result.agreement)`). Precision and recall are on the agreed set; the flag rate (SKUs with at least one model/verifier disagreement, which would go to the officer) is reported separately.
  - All three get the manifest's documented implication R-WHEAT-IS-GLUTEN (wheat `contains` implies gluten_cereal `contains`) so they are scored like the reference; the report says so.
- One model call per SKU (N); K and N+V reuse it. Run the SKUs one at a time.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/eval/metrics.ts` | Pure functions, no I/O: per-group precision and recall of `contains` (reported only for groups with support of at least 3; micro average over all scored pairs too); trap false-alarm rate (pairs whose group has a trap word in `traps_present` per `TRAP_TERMS`, reference `none`, system says `contains` or `may_contain`); precautionary accuracy (reference `may_contain` pairs where the system says exactly `may_contain`); the same micro P/R on the multilingual subset (`off_snapshot.lang` not `en`); JSON validity (valid on the first attempt, and valid at all, over model calls); planner tool-call validity (planner calls valid first try / planner calls) and fallback-step count from loop summaries; medians for tokens/s and seconds per SKU; evidence quality: **E-cov** (claims with at least one evidence id / claims, over `card`, `decision.firings`, `decision.review`, `claim_tests` and `contradictions`), **E-complete** (evidence records with every required field for their kind / records; the required fields are those listed in `docs/cursor-tasks/C5-evidence-drawer-and-ledger.md`), **E-replay** (Zetaris and DQ records re-run with the same template and params whose cited rows are all still present / records re-run), **E-ground** (grounded spans / grounded + dropped ungrounded spans, with the dropped count), **E-contra** (expected contradiction kinds surfaced / expected), and the two safety invariants as counts (CLEAR or CLEAR_WITH_STATEMENT on a SKU with an exact-GTIN Ongoing recall; executed CLEAR, CLEAR_WITH_STATEMENT or RELEASE rows without an officer-signed contract in the verifier log). A rate with an empty denominator is `null`, never 0 or 1. |
| `agent/src/eval/extraction.ts` | The extraction evaluation above: reads the manifest, reads each text through the gateway, runs K, N and N+V, and returns per-SKU records (GTIN, display name, lang, labels per system, model metrics, wall ms) and the metrics. Never stores the text, spans or `evidence_text` in its output: only group labels and counts. |
| `agent/src/eval/vram.ts` | Samples `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits` once a second while the eval runs (whole GPU, includes other processes; label it so), records the value before the run and the peak, and reads Ollama's `size_vram` for the model from `/api/ps` (through `OllamaClient` or the same loopback-checked URL). If `nvidia-smi` is missing, the result is "not measured". |
| `agent/src/eval/run.ts` | Extend the existing runner: after each scenario that ran an investigation, compute the evidence-quality metrics for its card (E-replay re-runs the cited templates through the gateway; E8's synthetic records are left out of E-replay and said so); compute the safety invariants over the scenario results and the current ops decisions (exact-GTIN recalls through the gateway's `recalls_by_gtin` template); run the extraction evaluation; run the cold-versus-warm pair; sample VRAM throughout; write `data/eval/eval-<ISO timestamp>.json` with sections `run` (date, model, settings, git commit, machine GPU name), `scenarios`, `evidence_quality`, `safety`, `extraction`, `planner`, `performance`, `vram`, `cold_warm`, `not_measured`; then render the report. Before any model work, check free RAM (`os.freemem()`) and stop with a clear message below 3 GB; never run two model calls at once. Flags: `--suite all\|scenarios\|extraction\|cold-warm` (default all), `--only E1,E10`, `--limit N` (extraction SKUs), `--no-model`, `--cold-warm <GTIN>:<UK\|US>` (default `0044000882105:US`), `--report-only [--in <eval json>] [--out <markdown path>]` (default in: the newest `data/eval/eval-*.json`; default out: `docs/eval-report.md`). |
| Cold versus warm | The same SKU twice in one process with nothing written: first with the warm extraction lookup off (cold), then with it on (warm, which reuses the verified extraction H-MEM holds for an unchanged label). For each run record chunks, planner tokens in/out, tool-model tokens in/out, `extraction.reused`, wall ms and the decision, labelled measured. If the warm run did not reuse the extraction, record that and do not call it warm. To switch the lookup off, add an optional `warm?: boolean` to `InvestigateRequest` in `agent/src/runtime.ts` (default on; `false` leaves the `warm` port out). That is the only change outside `agent/src/eval/` and `cli.ts`. |
| `agent/src/eval/report.ts` | Renders the report (default `docs/eval-report.md`) from the newest `data/eval/eval-*.json` (or a given file): title and run line (date, model, settings, commit); a short "how to read this" paragraph (measured vs estimated, reference labels, synthetic E8, the replay banner for E2); the scenario table (id, input, expected, got, rules, pass or fail, notes and `spec_note`); evidence quality against the SPEC targets (E-cov 100%, E-complete 100%, E-replay at least 95%, E-ground 100% with dropped spans counted, E-contra 100%); the safety invariants (target 0 and 0); the extraction table per system (per-group P/R for support at least 3 with the support, micro P/R, trap false-alarm rate, precautionary accuracy, multilingual subset, JSON validity, N+V flag rate) and the SKUs not measured; planner validity and fallback steps; performance (tok/s, seconds per SKU, VRAM); cold vs warm; the reference-label rules copied from `label_rules` in the manifest (scope, recall rules, text rules, second pass, adjudication, limits); and a "Not measured" list. Every number shows its label; anything not run is printed "not measured". SKUs are named by GTIN and the manifest `display_name` only. |
| `agent/src/cli.ts` | Wire the new flags (`eval` already calls `runEval`). Small change only. |
| `agent/test/eval-metrics.test.ts` | Unit tests for `metrics.ts` and the report renderer on synthetic inputs. |

## Constraints

- Only measured numbers. Every number in the JSON and the report carries its label (`measured`, or `estimated (chars/4)` where a baseline is estimated). Nothing is rounded up, extrapolated or filled in by hand; a missing measurement is printed "not measured".
- `docs/eval-report.md` and every committed file contain no Open Food Facts ingredient text, no span or `evidence_text` strings, no secrets, no e-mail addresses and no names of development tools other than Cursor.
- Synthetic fixtures (E8) are labelled synthetic in the JSON and in the report.
- The evaluation reads sources only through the gateway (Zetaris) and the model only through local Ollama. It writes no decision rows, approvals or contracts (`investigate`, not `clearWithAgent`).
- `data/eval/` stays gitignored; only `docs/eval-report.md` is committed.
- The policy, extraction and verifiers are not changed to improve scores. Do not edit `engines/`.
- Live runs (gateway, Zetaris, Ollama) are done by the reviewer afterwards on a shared machine: do not start the gateway, load a model or run the live evaluation. The checks below need none of them.

## Checks

- `cd agent && npx vitest run --maxWorkers=2` is green, including `eval-metrics.test.ts`: precision and recall on a hand-checked confusion table; the support threshold hides groups below 3; `unscored` pairs are left out; trap false-alarm and precautionary accuracy on small fixtures; an empty denominator gives `null`; E-cov and E-complete on records with a missing field; E-replay with a vanished row; a safety-invariant violation is counted; the report prints "not measured" for absent sections, prints the E2 `spec_note`, and contains no field named `evidence_text` or `ingredients_text`.
- `cd agent && npx tsc --noEmit` is clean.
- `cd agent && npm run eval -- --report-only --in <synthetic eval json> --out <temporary .md outside the repository>` renders a report from a synthetic eval file. Do not create or commit `docs/eval-report.md` and do not leave files in `data/eval/`: the committed report comes only from the reviewer's live run.

## Out of scope

Changing the policy, extraction or verifiers to improve scores; choosing or registering manifest SKUs; the `/eval` page in the UI.

## Commit

`C6: evaluation runner and report (Cursor Agent)`
