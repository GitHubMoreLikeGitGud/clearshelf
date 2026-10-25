# How Cursor was used

ClearShelf was developed in a Cursor workspace with project rules in `.cursor/rules`. Cursor Agent ran the Zetaris JDBC preflight against our local instance. It drafted the decision write-back SQL, the per-product Open Food Facts registration template and the DQ rule documentation, with static tests for the SQL. It also drafted the multilingual allergen lexicon, the jurisdiction rules, the GTIN normaliser and the claim tester, with their tests. After the submission and an upgrade to the Pro plan, it made the runtime tests independent of the date (C9). This page lists every Cursor task and its commits, and what was corrected afterwards.

Cursor Agent did not build the officer UI, the investigation loop, the memory integration or the evaluation. The Cursor Free plan reached its usage limit during task C3, so tasks C4 to C8 were not run by Cursor Agent (see [below](#tasks-not-run-by-cursor-agent)).

## How the workspace is set up

- **`AGENTS.md`** (repository root): the rules that always apply. It covers the layout, Lightning SQL rules, Zetaris scope, the read-only engines, "the model never decides", one data path, source etiquette, secrets, licences and integrity.
- **`.cursor/rules/`**, five project rules:

  | Rule file | Applies to | Covers |
  |---|---|---|
  | `safety.mdc` | always | decision safety, risk asymmetry (HOLD/BLOCK automatic, CLEAR/RELEASE signed), untrusted input, secrets, integrity |
  | `style.mdc` | always | languages, code style, tests, commit conventions |
  | `zetaris.mdc` | `gateway/`, `zetaris/`, `ops/`, `agent/src/zetaris/` | Lightning SQL rules for the gateway, onboarding scripts and USL model |
  | `meterless.mdc` | `engines/`, `agent/src/memory/`, `world/`, `loop/`, `contract/` | Meterless engine contracts and the never-edit rule for `engines/` |
  | `data-licences.mdc` | `data/`, `docs/`, `zetaris/`, `README.md`, `NOTICE`, `metadata.json`, `scripts/` | licences, attribution text, what data may be committed |

- **Task files** in [`docs/cursor-tasks/`](cursor-tasks/README.md). Each one is a self-contained brief with the same sections: goal, workspace, files to read, inputs, deliverables, constraints, checks, out of scope, commit message. Cursor Agent ran headless from the repository root:

  ```powershell
  & "$env:LOCALAPPDATA\cursor-agent\cursor-agent.cmd" -p --trust --force --workspace . --output-format text "Read docs/cursor-tasks/<file>.md and complete it. Run the listed checks until green."
  ```

- **Review.** Each run's changes were reviewed with `git diff` and committed unchanged as `Cn: <task> (Cursor Agent)`. During C2, other work was in progress in two of the same files, so only Cursor Agent's insertions were staged. Corrections went into separate commits, so the history shows what Cursor Agent wrote and what changed later.

CLI version 2026.10.22. G9 and C1 to C3 ran on 23 Oct 2026 (SGT) with model `Auto` on the Cursor Free plan. C9 ran on 25 Oct 2026 (SGT), after the submission, on the Cursor Pro plan.

## Tasks run by Cursor Agent

| Task | What Cursor Agent produced | Commit | State at the end of the run | Corrected afterwards |
|---|---|---|---|---|
| **G9** smoke run | Appended the task index table to `docs/cursor-tasks/README.md`. | `6b732e3` "G9: task index (Cursor Agent)" | 21.3 s, exit 0 | The status column is updated as tasks run. |
| **C1** Zetaris JDBC preflight ([task file and run record](cursor-tasks/C1-zetaris-preflight.md)) | Ran the Zetaris getting-started preflight against our local instance, read-only, in a clone of the getting-started repository. It found the failing checks to be Windows path false negatives and confirmed read-only JDBC with a direct connection. It changed no files. | No Cursor commit: the run changed no files. The run record is commit `f0d990f`. | 65.8 s, exit 0. Result: **Preflight NOT READY on Windows (bin/java and .venv/bin/python path false negatives, verified); read-only JDBC confirmed directly: SELECT 1, SHOW LIGHTNING DATABASES, SHOW NAMESPACES** | Its finding went into the gateway: `gateway/jdbc.py` accepts `bin\java.exe` as well as `bin/java`. |
| **C2** decision write-back SQL, OFF template, DQ rule docs ([task file and run record](cursor-tasks/C2-lightning-sql-and-usl.md)) | `zetaris/sql/14_decision_writeback_create.sql` and `_select.sql` (two REGISTER DQ rules as the task gave them, write-back parity, current decision per GTIN and market, closed-loop recheck, DQ-equivalent SQL). Also `zetaris/templates/off_product_template.sql`, `zetaris/dq-rules.md`, `gateway/tests/test_sql_scripts.py` (13 static tests) and the manifest entry. It also made four review findings on the earlier SQL pairs 00 to 13, and all four were correct. | `c499ca5` "C2: decision write-back SQL, OFF template, DQ rule docs and static SQL tests (Cursor Agent)" | 295.4 s, exit 0. New tests 13/13; every SQL file passed the dry run. | `f6e08cb`: the current-decision query uses a LEFT JOIN; tests no longer need a gitignored file; an assertion that could not fail was fixed; the Day-0 results table was restored. `cbdcecb`: a signed RELEASE is stored as the CLEAR row it results in, and the `signed_clear` rule and status description were updated to match. |
| **C3** lexicon, jurisdiction, GTIN normaliser, claim tester ([task file and run record](cursor-tasks/C3-lexicon-and-verifiers.md)) | 10 files, 2,339 lines: `agent/src/verify/lexicon.data.ts` (allergen terms in EN/DE/FR/ES/IT, traps, precautionary and free-from patterns), `lexicon.ts`, `jurisdiction.ts`, `gtin.ts`, `claims.ts`, four vitest suites and a synthetic fixture file. | `59cf150` "C3: lexicon, jurisdiction, GTIN normaliser and claim tester (Cursor Agent)", committed exactly as the run left it, one failing test included | 545.7 s, **exit 1: the Free plan usage limit was reached** after its first test run (99 of 100 passing). `tsc --noEmit` clean. | `be9edbd`: a test bug; UPC-E codes, pack sizes and recall numbers in `extractUpcs`; free-from words and German compounds in the lexicon; span coverage; coconut inside tree-nut lists. `58d6420`: span matching at every occurrence; plant-drink and look-alike traps; missing terms; German "enthalten" scope; an unverified contradiction leaves a claim untested. `npm test` went from 100 tests (99 passing) to 140 across the two reviews. |
| **C9** clock-independent runtime tests ([task file](cursor-tasks/C9-clock-independent-tests.md)) | An optional `today` on `openRuntime`, used by `investigate` and `asReplay` instead of the wall clock when given; the runtime tests pin it to 23 Oct 2026. Before, a fresh clone failed 3 of 419 tests from 24 Oct, because an as-of date of 23 Oct turned into a replay. | `ac22af3` "C9: clock-independent runtime tests (Cursor Agent)", committed unchanged | 81.4 s, exit 0. `npm test` 419 of 419, type check clean, and 419 of 419 again with the clock moved 60 days later. | Nothing. |

Commits marked `(Cursor Agent)`: `git log --grep "(Cursor Agent)"` lists `6b732e3`, `c499ca5`, `59cf150` and `ac22af3`.

**How much of it is still in the tree.** At commit `7033a11`, `git blame` attributes 2,727 lines in 18 files to those three commits, unchanged since. The largest shares are `lexicon.data.ts` (594 of 745 lines), `lexicon.ts` (388 of 553), `test_sql_scripts.py` (365 of 416), `gtin.ts` (190 of 272), `jurisdiction.ts` (183 of 191) and `claims.ts` (147 of 169).

The Zetaris SQL pairs 00 to 13 and the `clearance_usl` model were written and run during the Day-0 gates (commit `c65d57f`), before C2. Cursor Agent reviewed them but did not write them.

## Tasks not run by Cursor Agent

The Free plan limit was reached at about 09:29 SGT on 23 Oct 2026, during C3. A C4 run at 15:06 SGT exited after 7.4 s with `ActionRequiredError: You've hit your usage limit`. It made no tool calls and changed no files. A test prompt at 16:12 SGT got the same reply.

| Task | Task file | Status |
|---|---|---|
| C4 | [`C4-ui-screens.md`](cursor-tasks/C4-ui-screens.md) | Not run by Cursor Agent (refused at the usage limit). The officer UI in `ui/` was built outside Cursor Agent (commit `7033a11`). |
| C5 | [`C5-evidence-drawer-and-ledger.md`](cursor-tasks/C5-evidence-drawer-and-ledger.md) | Not run by Cursor Agent. The evidence drawer, why trace and telemetry footer were built outside Cursor Agent (commit `7033a11`). |
| C6 | [`C6-eval-runner.md`](cursor-tasks/C6-eval-runner.md) | Not run by Cursor Agent. The scenario runner and the measurement scripts were written outside Cursor Agent. The report generator was not built, so `docs/eval-report.md` is written from the measurement output. |
| C7 | [`C7-readme-drafts.md`](cursor-tasks/C7-readme-drafts.md) | Not run by Cursor Agent. `README.md` and this page were written outside Cursor Agent. |
| C8 | not written | Not run. No interactive Cursor editor session is recorded. |
