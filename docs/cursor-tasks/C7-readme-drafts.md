# C7: README and "How Cursor was used" first drafts

## Goal

First drafts of `README.md` and `docs/how-cursor-was-used.md` that a judge can follow from a fresh clone, built only from what the repository and its records show. The owner edits them afterwards.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/data-licences.mdc`, `.cursor/rules/style.mdc`.
- `metadata.json`, `NOTICE`, `LICENSE`, `engines/UPSTREAM.md`, `docs/conformance.md`, `docs/eval-report.md`, `zetaris/README.md`, `docs/cursor-tasks/` (every task file and run record), and `git log --format="%h %ad %s" --date=short`.

## Deliverables

### `README.md`, in this order

1. What ClearShelf does: the user (the product-compliance officer at a UK online grocer that also sells US- and EU-made packaged foods), the problem (reconciling label data with FSA and FDA allergy recalls before and after listing), and a placeholder for the demo video link.
2. Quickstart. Prerequisites: Docker Desktop with the Zetaris local install, Java 21, Python 3.12, Node 22, Ollama, then `ollama pull nemotron-3-nano:4b`. Steps: copy `.env.local.example` to `.env.local`; `python -m venv .venv` and install `gateway/requirements.txt`; `docker compose -f ops/docker-compose.ops.yml up -d`; `python gateway/onboard.py --dry-run`, then the real run; `cd agent && npm install`; `npm run warmup`; `npm run dev`. Use the commands as they exist in the repository; if one does not exist yet, mark it "TODO".
3. Usage: the four screens and the CLI (`clear`, `watch --as-of`, `replay`, `eval`).
4. Architecture diagram (link `docs/architecture.png` if present, else a text diagram).
5. Zetaris usage: Lightning databases, REST tables, the `clearance_usl` USL, the DQ gate, write-back and the closed-loop recheck, least privilege or its documented limitation, and every fallback actually used (from `zetaris/README.md`).
6. Meterless usage, per engine: vendored versus reimplemented (Scout Intent is a partial reimplementation, labelled as such) and the conformance results from `docs/conformance.md`.
7. NVIDIA: model, settings and the measured numbers from `docs/eval-report.md`.
8. How Cursor was used: the statement below, then a link to `docs/how-cursor-was-used.md`.
9. Dependencies with licences.
10. Data and licences, with these exact lines: "Data from Open Food Facts (openfoodfacts.org), ODbL"; openFDA public domain / CC0 with no FDA endorsement; "Contains public sector information licensed under the Open Government Licence v3.0" (FSA); no bulk data in the repository; no personal data; firm addresses not read.
11. Evaluation results (from `docs/eval-report.md`).
12. Limitations and safety: decision support only, not legal advice; never auto-publishes free-from claims; Open Food Facts is crowd-sourced; the officer identity is a local demo identity and a real deployment needs SSO.
13. Pre-existing code: the Meterless reference engines and the adapted Zetaris getting-started `zetaris_sql.py`, both Apache-2.0.

The Cursor statement, used only for the parts that the task records show actually happened (drop any clause that is not yet true and list it as TODO):

> ClearShelf was developed in Cursor. The repository is a Cursor workspace with project rules in `.cursor/rules`. Cursor Agent ran the Zetaris getting-started JDBC preflight against our local instance, drafted the Lightning SQL onboarding scripts and the clearance_usl model from sample API responses, wrote the multilingual allergen lexicon and its tests, built the four UI screens and the evidence drawer, and wrote the evaluation runner. Each task and its commit are listed in docs/how-cursor-was-used.md.

### `docs/how-cursor-was-used.md`

- How the workspace is set up (`AGENTS.md`, the five `.cursor/rules/*.mdc` files and what each covers).
- The task-file convention (link `docs/cursor-tasks/README.md`) and the headless command.
- A table: task, task file, what Cursor Agent did, commit hash(es) from `git log --grep "(Cursor Agent)"`, and the checks that passed. Only tasks with a commit or a run record are listed as done; the rest are "planned".
- Interactive use in the Cursor editor (C8) as a placeholder for the owner to fill in.

## Constraints

- Every number comes from a committed record (`docs/conformance.md`, `docs/eval-report.md`, `zetaris/README.md`, task run records). Never invent or round a number; write "TODO (measured)" where none exists yet.
- Public text names no development tool other than Cursor, and never claims replayed events were live.
- No credentials, no local private paths, no contact e-mail addresses.
- Keep `metadata.json` as it is; report any mismatch with the README instead of editing it.

## Checks

- Every relative link in both files resolves to a file in the repository (check with a small script or by listing).
- Every command in the Quickstart exists in `agent/package.json`, `gateway/` or `ops/`, or is marked TODO.
- A search of both files for `password`, `secret`, `@` (outside licence and URL text) and absolute drive paths finds nothing.

## Out of scope

The slide deck, the video, `metadata.json` and `NOTICE` edits.

## Commit

`C7: README and how-cursor-was-used drafts (Cursor Agent)`
