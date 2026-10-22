# C5: Evidence drawer and ledger trace

## Goal

Every claim in the UI opens a drawer that shows exactly where it came from, and "Why was this held?" shows the H-MEM ledger trace merged with the decision log, in about five lines.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/meterless.mdc`, `.cursor/rules/data-licences.mdc`.
- `docs/api.md` (evidence and why endpoints) and `agent/src/evidence/store.ts` (the evidence record type).
- The C4 views (`ui/views/card.js`, `ui/views/memory.js`) for the mount points.

## Inputs

An evidence record (one JSON line in `data/evidence/<runId>.jsonl`):

```json
{"id":"ev-r12-07","run_id":"r12","kind":"zetaris_sql|model_extraction|verifier|memory|world_model|policy|dq",
 "claim":"FDA H-1328-2026 reports UPC 816929000119 tested positive for undeclared milk",
 "template_id":"recalls_by_gtin","sql":"SELECT ...","sql_sha256":"...",
 "zetaris_object":"lightning.metastore.clearshelf.clearance_usl.fda_recall",
 "raw_objects":["clearshelf_fda.enforcement_undeclared"],
 "source_url":"https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000",
 "licence":"openFDA public domain / CC0","queried_at":"...","source_cached_at":"...",
 "rows":[],"row_count":1,"elapsed_ms":412,"cache_state":"hit|miss|unknown",
 "model":{"name":"nemotron-3-nano:4b","think":false,"prompt_sha256":"...","tokens_in":1830,"tokens_out":212,"label":"measured"}}
```

The ledger trace: `ledger.history(memoryId)` entries (actor, action, time, reason) and decision-log entries for the same GTIN and market.

## Deliverables

| File | Contents |
|---|---|
| `ui/views/evidence.js` | `openEvidence(ids)` and a pure `renderEvidence(records): string`. Shows, per record: the claim; kind; the Lightning SQL in a monospace block with a copy button; `sql_sha256`; up to 20 rows as a table with the row count; the Zetaris object and raw objects; the source URL and licence; `queried_at` and `source_cached_at` side by side with a plain "source cached N minutes before the query" line; cache state; elapsed ms; and, for model evidence, model name, think flag, tokens in and out with their label. An "Open in Zetaris" link for the object. Records of kind `dq` say whether the result came from Zetaris DQ or from "DQ-equivalent SQL". |
| `ui/views/why.js` | `openWhy(gtin, market)` and a pure `renderWhy(trace): string`: the merged, time-ordered trace (memory created, conflict detected, conflict resolved by officer with rule label, decision proposed, decision executed or signed), each line with its actor and a link to its evidence. |
| `ui/styles.css` | Drawer styles only (append; do not restyle C4). |
| `agent/test/evidence-render.test.ts` | Render tests (see Checks). |

## Constraints

- Escape every field before rendering; SQL and rows are shown as text, never as HTML.
- Show missing required fields as "missing" in red rather than hiding them, so incomplete evidence is visible.
- The drawer reads evidence; it never edits it.
- Licence strings are shown exactly as stored (Open Food Facts ODbL, openFDA public domain / CC0, FSA Open Government Licence v3.0).

## Checks

- `cd agent && npm test` is green, including `evidence-render.test.ts`, which asserts: every required field of the record above appears in the rendered drawer; a missing field renders as "missing"; a `<script>` inside a row value is escaped; the why-trace is in time order and names the officer on officer actions.
- `node --check` passes for the new files.
- Manual check by the reviewer: open a drawer from a card claim and the "Why?" link on a held SKU.

## Out of scope

Evidence storage, the ledger itself, and server endpoints.

## Commit

`C5: evidence drawer and ledger trace (Cursor Agent)`
