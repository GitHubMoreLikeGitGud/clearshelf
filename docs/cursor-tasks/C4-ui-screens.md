# C4: The four officer screens

## Goal

The officer UI in `ui/` works end to end against the agent server's `/api` contract: Intake and catalogue, SKU card, Recall watch, and Memory and Why, with live updates over SSE and the telemetry footer. Plain HTML, CSS and ES modules, no build step, served by the agent server on 127.0.0.1:8790.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/style.mdc`.
- `docs/api.md`: the `/api` contract (endpoints, request and response shapes, SSE event types). It is authoritative. If it is missing, stop and report; do not invent endpoints.
- `agent/src/server.ts` to see how `ui/` is served.

## Inputs

- Example responses in `docs/api.md`, used as render fixtures.
- Decision states: `CLEAR`, `CLEAR_WITH_STATEMENT`, `HOLD`, `BLOCK`. Claim verdicts: `SUPPORTED`, `PARTLY_SUPPORTED`, `NOT_SUPPORTED`, `UNTESTED`.

## Deliverables

| File | Contents |
|---|---|
| `ui/index.html`, `ui/app.js`, `ui/styles.css` | Shell with four tabs, hash routing (`#/intake`, `#/sku/<gtin>/<market>`, `#/watch`, `#/memory`), one `EventSource('/api/events')` shared by all views, and the footer. |
| `ui/views/intake.js` | Paste GTINs (one per line or comma separated) and pick UK or US. Live progress per GTIN from SSE: registering in Zetaris, fetching, reading, verifying, deciding. Catalogue table with a status chip per SKU and market. "Open in Zetaris" links (Data Explorer and the `clearance_usl` ERD) from the URLs in `docs/api.md` or the server config. |
| `ui/views/card.js` | SKU card: source cards (Open Food Facts, FDA, FSA, reference) each with evidence chips; extracted spans highlighted in the ingredient text with a verifier tick or cross; claim-tester verdict; contradictions panel; "Not checked" list; memory hits; proposed decision and statement; Approve, Edit and Reject, each with a required reason box; Markovian chunk timeline; a "Why?" link to the ledger trace. The evidence drawer itself is C5: leave a mount point and a `openEvidence(ids)` call. |
| `ui/views/watch.js` | Recall watch: "Poll now" and "Replay as of <date>" buttons; a visible "Replay as of <date>" banner whenever replay is on; new notices; exact matches with the auto-HOLD or auto-BLOCK applied; name-only matches in a review queue; the approval queue; the join map (per transform: links, in catalogue, orphans); the closed-loop recheck result; the sweep timeline with a tokens-per-chunk chart (measured Markovian line against the estimated naive line, both labelled). |
| `ui/views/memory.js` | H-MEM conflict queue (resolve with a reason), dream proposals (approve or reject; wording labelled "wording by Nemotron, derived from N memories"), ledger trace view, World Model timeline per SKU, the merge queue, and the source-access memories. |
| Footer (in `app.js`) | Model name, measured tok/s, peak VRAM, "0 cloud model calls", cold-versus-warm chunk and token counts, from the telemetry endpoint. Values are shown with their label (`measured` or `estimated`). |
| `agent/test/ui-render.test.ts` | Render tests (see Checks). |

Each view exports a pure `render<View>(data): string` used by the DOM code, so it can be tested without a browser.

## Constraints

- Every piece of source text (product names, ingredients, notice text, alert titles, reasons) is untrusted: escape it before it reaches the DOM. Never assign unescaped data to `innerHTML`.
- The UI never decides. Approve sends the officer's approval to the server, which signs the contract; the UI never builds or signs a contract, and shows a 403 from the server as a refusal.
- No external scripts, fonts or CDNs; everything is local. Works at 1280 px and 1920 px wide.
- Labels match the server's: "measured", "estimated (chars/4)", "time-lapse" where used, and the replay banner.
- No changes to `agent/src/` beyond what `docs/api.md` already documents; report gaps instead.

## Checks

- `cd agent && npm test` is green, including `ui-render.test.ts`, which renders each view from the `docs/api.md` examples and asserts: a product name containing `<script>` is escaped; every claim shown on the card has at least one evidence chip; the replay banner appears when replay is on; HOLD and BLOCK chips render for auto-applied matches; Approve is disabled until a reason is entered.
- `node --check` passes for every file in `ui/`.
- Manual check by the reviewer in a real browser (all four screens, end to end).

## Out of scope

The evidence drawer and ledger trace components (C5), server endpoints, and the `/eval` page (C6).

## Commit

`C4: officer UI screens (Cursor Agent)`
