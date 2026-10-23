# C4: The four officer screens

## Goal

The officer UI in `ui/` works end to end against the agent server: Intake and catalogue, SKU card, Recall watch, and Memory and Why, with live updates over server-sent events and the replay banner. Plain HTML, CSS and ES modules, no build step, served by the agent server (`agent/src/server.ts`) on `http://127.0.0.1:8790`.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/style.mdc`.
- `docs/api.md`: the `/api` contract (endpoints, request and response shapes, SSE events, the tool-to-stage map for intake progress, the Zetaris links). It is authoritative. Do not invent endpoints; if the UI needs data no endpoint returns, list the gap in your final message.
- `agent/src/server.ts` (how `ui/` is served, the Host and Origin checks), and the types `docs/api.md` names: `ClearResult` in `agent/src/pipeline.ts`, `LoopReport` in `agent/src/loop/investigate.ts`, `QueueItem` in `agent/src/ops/queue.ts`, `SweepResult` and `WatchState` in `agent/src/watch/recallWatch.ts`, `WhyTrace` and `InvariantProposal` in `agent/src/memory/hmemFacade.ts`, `AllergenConflict` in `agent/src/memory/allergenConflicts.ts`.
- `agent/test/server.test.ts` for how tests start a server with a fake gateway (`agent/test/helpers/fakeZetaris.ts`).

## Inputs

- Decision states: `CLEAR`, `CLEAR_WITH_STATEMENT`, `HOLD`, `BLOCK`. Claim verdicts: `SUPPORTED`, `PARTLY_SUPPORTED`, `NOT_SUPPORTED`, `UNTESTED`.
- Render fixtures: write synthetic ones in the test file, shaped exactly like the types above (made-up GTINs such as `0012345678905`, made-up product names). No Open Food Facts text and nothing copied from `data/`.

## Deliverables

| File | Contents |
|---|---|
| `ui/index.html` | Shell: header with the four tabs, a replay-banner slot, the view container, a drawer container (filled by C5) and a `<footer id="telemetry">` (filled by C5). Loads `app.js` as a module. No inline scripts. |
| `ui/styles.css` | Layout and components (tabs, tables, status chips, evidence chips, banner, buttons, forms). Works at 1280 px and 1920 px wide. |
| `ui/lib.js` | Shared helpers: `escapeHtml(value)` (used for every piece of data that reaches HTML), `api(path, { method, body })` (JSON in and out; resolves to `{ ok, status, data }` so callers can show 403/409 bodies), a single shared `EventSource('/api/events')` with `on(type, fn)` subscriptions, `statusChip(status)`, `evidenceChips(runId, ids)` (each chip a button with `data-run` and `data-ev`), and `replayBanner(text)`. |
| `ui/app.js` | Hash routing (`#/intake`, `#/sku/<gtin>/<market>`, `#/watch`, `#/memory`; default `#/intake`), mounts the view, shows the replay banner from `/api/health` (`watch.banner`) and refreshes it on `watch.state` events, delegates clicks on evidence chips to `openEvidence(runId, ids)` and on "Why?" links to `openWhy(gtin, market)` from the C5 modules. Until C5 lands, create `ui/views/evidence.js` and `ui/views/why.js` as small stubs exporting those two functions (they list the ids, or `/api/why` `lines`, in the drawer); C5 replaces them. |
| `ui/views/intake.js` | Paste GTINs (one per line or comma separated; each must be 13 digits, shown invalid otherwise) and pick UK or US; Submit posts one `POST /api/clear` per GTIN (the server queues them). Live progress per GTIN from `loop.tool` events using the tool-to-stage map in `docs/api.md` (registering in Zetaris, fetching, reading, verifying, deciding), plus queued/done/failed from `job.*` and the outcome from `clear.done` / the job result. Catalogue table from `/api/catalogue`: GTIN, name, brand, one status chip per market (current decision, or "pending approval", or "not cleared"), link to the card. Refresh the table on `decision.written` and `approval.*` events. "Open in Zetaris" links as described in `docs/api.md` (home page plus the written path). |
| `ui/views/card.js` | SKU card for one GTIN and market from `/api/sku/:gtin` (its `run`). When `run` is null, show the current decision row if there is one, say "not cleared yet in this market", and offer a Clear button. Every clearance is kept as a run (intake, command line, sweeps and the scenario eval); show `run.saved.note` and say plainly when the run applied nothing (`saved.applied` false, for example an eval run) next to the current decision. Shows: product line; current decision row; proposed decision with every firing (rule, effect, reason, evidence chips); statement draft (entries marked "(to confirm)" are verifier finds the model missed; show them distinctly and keep Approve disabled while any remain); source cards for Open Food Facts, FDA, FSA and reference, each listing the card claims (`run.card`) and evidence records of that source with chips (group by the evidence record's `zetaris_object`/`raw_objects`; fetch `/api/evidence/:runId` once); the ingredient text (from the `product` evidence record's `rows`) with each verified span highlighted and a tick when the verifier agreed or a cross when it did not (`details.agreement` of the `verifier` record); claim-tester verdicts; contradictions panel; "Not checked" list; memory hits (memory evidence and `contradictions` of kind `memory_conflict`); the Markovian chunk timeline (`run.loop.timeline`, chunk by chunk, model or fallback step, with evidence chips) and an empty `<div data-mount="token-chart">` for C5; a "Why?" link. Officer actions on a pending proposal (`pending` from `/api/sku`): Approve, Edit (statement text box) and Reject, each with a required reason box; Approve and Edit call `POST /api/approvals/sign` (action = the proposal's status, the statement shown, reason, `officer: "officer"`, `queue_id`) and then `POST /api/execute` with the contract it returned; Reject calls `POST /api/approvals/reject`. Manual HOLD and BLOCK buttons (reason required) call `POST /api/decisions`. Every refusal (403) or conflict (409) is shown with the server's `error` text. Live: refresh on `decision.written` / `approval.*` for this GTIN and market. |
| `ui/views/watch.js` | Recall watch: "Poll now" (`POST /api/watch/poll`), "Replay as of <date>" with a date input (`POST /api/watch/replay` with `poll: false`), "Go live" (`POST /api/watch/live`), the banner whenever `/api/watch/state` has one; the newest sweeps (`/api/watch/sweeps`, then each record) with: new notices (source, id, date, title, allergens), exact matches with the action applied (HOLD or BLOCK chip, `decision_id`, visible in Zetaris yes/no), name-only matches as a review queue with Confirm (holds) and Dismiss, both with a required reason (`POST /api/approvals/confirm` / `reject`); the approval queue (`/api/approvals?state=pending`); the join map (`/api/join-map`: transform, links, in catalogue, orphans = links − in catalogue) and the closed-loop recheck (`/api/recheck`: row count, SQL in a `<pre>`, elapsed ms); the sweep model use (`model.calls`, tokens in/out with its label). Live: show `watch.*` events as a running log while a sweep runs, then reload the sweep on `watch.sweep_done`. An empty `<div data-mount="token-chart">` for C5. |
| `ui/views/memory.js` | H-MEM conflict queue (`/api/memory/conflicts?state=queued`): allergen, both sides with their polarity and scores, Resolve with winner, rule label and a required reason (`POST /api/memory/conflicts/resolve`, a job); dream proposals (`/api/memory/dreams`): the wording labelled exactly as its `wording.label` and "derived from N memories", Approve or Reject with a reason; a GTIN + market picker that shows the "Why?" trace (`openWhy`) and the World Model timeline (`/api/world/timeline/:gtin`); the merge queue (`/api/world/merges`) with Approve and Reject; an empty `<div data-mount="source-memories">` for the source-access memories (C5 adds their endpoint and panel). Live: refresh on `memory.*` and `world.*` events. |
| `agent/test/ui-render.test.ts` | Render tests (see Checks). |

Each view module exports pure `render…(data): string` functions that the DOM code uses, plus one `mount(el, ctx)` that does the fetching and event wiring. Importing a view module must not touch `document`, `window` or `EventSource` (so the tests can import it in Node).

## Constraints

- Every piece of source text (product names, ingredient text, notice titles and reasons, alert titles, officer reasons, memory content) is untrusted: it reaches the DOM only through `escapeHtml` or `textContent`. Never put unescaped data into `innerHTML`, attributes or URLs.
- The UI never decides and never builds or signs a contract. Approve sends the officer's reason to the server; the contract comes back from `/api/approvals/sign` and is passed to `/api/execute` unchanged. Approve, Edit, Reject, Confirm, Dismiss and manual HOLD/BLOCK stay disabled until a reason is typed.
- Labels match the server's: "measured", "estimated (chars/4)", and the replay banner text exactly as the server sends it.
- No external scripts, fonts, images or CDNs; everything is local.
- Do not change `agent/src/` or `docs/api.md`. Report gaps in your final message.

## Checks

- `cd agent && npx vitest run --maxWorkers=2` is green, including `ui-render.test.ts`, which renders each view from synthetic fixtures and asserts: a product name and a notice title containing `<script>` and `"` are escaped; every claim and every firing shown on the card has at least one evidence chip; spans are highlighted and the tick/cross follows `agree`; the replay banner appears when the data has a `banner` and not otherwise; exact matches render HOLD and BLOCK chips; the officer buttons render disabled while the reason is empty; the join map shows orphans = links − in catalogue.
- `cd agent && npx tsc --noEmit` is clean. Tests load the UI modules without type errors, for example with `await import(new URL("../../ui/views/card.js", import.meta.url).href)` cast to a small interface.
- `node --check` passes for every `.js` file in `ui/`.
- The reviewer checks all four screens end to end in a real browser.

## Out of scope

The evidence drawer, the ledger-trace view and the telemetry footer and token chart (C5); server endpoints; the `/eval` page (C6).

## Commit

`C4: officer UI screens (Cursor Agent)`
