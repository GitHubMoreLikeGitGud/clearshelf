# C2: Lightning SQL for the decision write-back, the OFF template, DQ rule docs and static tests

## Goal

The Lightning SQL that the Day-0 gates did not write exists, and every SQL file in `zetaris/` is covered by a static test:

1. **Pair `14_decision_writeback`.** Two custom DQ rules on the USL `decision` table (the ops write-back contract), and the read queries that close the loop: write-back parity, the current decision per GTIN and market, and the closed-loop recheck run against the current decision only.
2. **`zetaris/templates/off_product_template.sql`.** The per-SKU Open Food Facts registration (CREATE, DESCRIBE, CACHE, re-activation) written once as a documented template with a `{gtin13}` placeholder.
3. **`zetaris/dq-rules.md`.** Every DQ rule on `clearance_usl`: what it checks, what an invalid record means for a decision, and which gateway template reads it.
4. **`gateway/tests/test_sql_scripts.py`.** Static checks over every file in `zetaris/sql/`, the template and `zetaris/manifest.json`.

Pairs 00 to 13 were written and run against the local instance at the Day-0 gates. Their measured results are in `zetaris/README.md`. They are reviewed in this task, not rewritten.

## Workspace

This repository. Pass the getting-started clone as a read-only extra root for its SQL guides: `--add-dir <path to the getting-started clone>`.

Other work may be in progress in the working tree while this task runs (for example `gateway/sqlgen.py`, `gateway/manifest.py`, `gateway/onboard.py`, a regenerated `zetaris/sql/04_*` or `11_*`, `zetaris/off_describe.json`). Leave every file that is not under **Deliverables** alone, even if it looks unfinished.

## Read first

- `AGENTS.md`, `.cursor/rules/zetaris.mdc`, `.cursor/rules/safety.mdc`, `.cursor/rules/data-licences.mdc`.
- `zetaris/README.md`, `zetaris/manifest.json` and every file in `zetaris/sql/`. If the README or the manifest is missing, stop and report.
- `gateway/jdbc.py` (`split_statements`), `gateway/allowlist.py` (`check`, roles `reader` and `onboard`), `gateway/run_sql.py` (`--dry-run`), `gateway/sqlgen.py` (`create_off_table`, `off_table`, `product_branch`, `declared_branch`, `TAG_MAP`), `gateway/templates.py` (`recheck_cleared`, `prior_decisions`, the `dq_invalid_*` and `dqsql_*` templates), and the existing tests in `gateway/tests/`. `test_allowlist.py` already checks every statement in `zetaris/sql/` against the `onboard` role, and `test_sqlgen.py` already compares the committed activation with the generator; do not repeat those two checks.
- In the getting-started clone: `AGENTS.md` ("Writing SQL"), `docs/guides/zetaris-lightning-sql-companion.md` (sections 2, 4, 5 and 8) and `docs/guides/zetaris-lightning-sql-commands.md` (sections 6, 13, 14 and 19).

## Inputs

Saved responses. They are gitignored, never committed and never quoted into committed files. Use them only to confirm names and nesting. Do not call any source API and do not connect to Zetaris.

- `data/curation/zetaris/list_dq_2026-10-23.json`: the output of `LIST DQ USL lightning.metastore.clearshelf.clearance_usl` on the local instance (20 rows: `name`, `table`, `type`, `expression`). This is the only source for rule names in `zetaris/dq-rules.md`.
- `data/ops/decisions.json`: the ops file behind `clearshelf_ops.decisions`. It holds only the `__schema__` sentinel row; no decision has been written yet.
- `data/curation/raw/fda_enforcement_undeclared.json` (openFDA, `{meta, results[]}`, 1,000 results) and `data/curation/raw/fsa_allergy_alerts.json` (FSA, `{meta, items[]}` with `problem[].allergen[]`, 200 items).
- `data/curation/off/<gtin13>.json`: one wrapper per Open Food Facts lookup, `{gtin, why, url, fetched_at, http_status, error, body}`; product fields are under `body.product.*`. Optional fields can be absent (for example `0816929000119` has no `brands` and no `ingredients_text`). Files with `http_status` 404 have no `body.product`; skip them.

openFDA food recall numbers start with `H-` or `F-` (for example `H-1328-2026`, `F-0636-2025`; 7 of the 18 recall-matched manifest SKUs are `F-`). No SQL filter, comment or test may assume a single prefix.

## Deliverables

| File | Contents |
|---|---|
| `zetaris/sql/14_decision_writeback_create.sql` (new) | Two `REGISTER DQ` statements on `lightning.metastore.clearshelf.clearance_usl.decision`, exactly as in "Pair 14" below, with a header comment in the style of `12_clearance_dq_create.sql`. |
| `zetaris/sql/14_decision_writeback_select.sql` (new) | The read queries in "Pair 14" below, each with a one-line comment. |
| `zetaris/templates/off_product_template.sql` (new) | See "OFF template" below. |
| `zetaris/dq-rules.md` (new) | See "DQ rule docs" below. |
| `zetaris/manifest.json` | **Insert** one entry for pair 14 after the `clearance_reactivate_probe` entry: `id` `decision_writeback`, `kind` `usl`, `script` `zetaris/sql/14_decision_writeback_create.sql`, `status` `drafted`, `requires` `["clearance_usl_activate"]`, and a one-sentence `summary`. Change nothing else in the file. |
| `zetaris/README.md` | **Insert** one row for `14_decision_writeback` in the script table, and after that table one sentence linking `dq-rules.md` and `templates/off_product_template.sql`. Change no other line: the counts and measured behaviour are the gate record. |
| `gateway/tests/test_sql_scripts.py` (new) | See Checks. Standard library and pytest only. |

Review findings on pairs 00 to 13 are not written into any file. List them in the final message (file, statement number from the dry-run output, the problem, the proposed text).

### Pair 14

`decision` rows are written by the ops writer to `data/ops/decisions.json` and read back through `clearshelf_ops.decisions` (never cached). The table is an append-only log: a later decision for the same GTIN and market supersedes an earlier one, so the "current" decision is the row with the latest `decided_at` for that `(gtin, market)`. `decided_at` is an ISO 8601 string written with one fixed offset, and `decided_date` and `fda_recall.report_date` are `YYYY-MM-DD`, so string comparison orders them; say this in the header comment.

Create file, exactly these two rules (same table only, no alias, no window functions):

```sql
REGISTER DQ signed_clear TABLE lightning.metastore.clearshelf.clearance_usl.decision AS status NOT IN ('CLEAR','CLEAR_WITH_STATEMENT') OR (contract_id IS NOT NULL AND length(trim(contract_id)) > 0)
REGISTER DQ known_status TABLE lightning.metastore.clearshelf.clearance_usl.decision AS status IN ('CLEAR','CLEAR_WITH_STATEMENT','HOLD','BLOCK')
```

`signed_clear` is the safety invariant "no CLEAR without a signed approval" checked inside Zetaris on the written-back rows: a CLEAR or CLEAR_WITH_STATEMENT row must carry the id of its signed execution contract. `known_status` admits only the four decision states.

Select file, in this order, all against `lightning.metastore.clearshelf.clearance_usl` unless stated:

1. `LIST DQ USL lightning.metastore.clearshelf.clearance_usl` (expects 22 rules once 14 has run).
2. Write-back parity, as two statements: the count of `clearshelf_ops.decisions LATERAL VIEW explode(data) x AS d WHERE d.decision_id <> '__schema__'`, and the count of the USL `decision` table. They must be equal.
3. The current decision per `(gtin, market)`: `decision_id, gtin, market, status, statement, decided_at, decided_date, actor, contract_id`, joined to `product` for `product_name`. Use a derived table with `MAX(decided_at)` grouped by `gtin, market`, joined back on all three columns. No `WITH` clause (the gateway's reader allowlist only admits statements that start with `SELECT`).
4. The closed-loop recheck on the current decision: the current decision (as in 3) joined to `recall_product_link` on `gtin` and to `fda_recall` on `recall_number`, where the current status is `CLEAR` or `CLEAR_WITH_STATEMENT` and `f.report_date >= d.decided_date`. Columns: `gtin, market, status, decided_at, decided_date, recall_number, report_date, classification, recall_status`. Comment why `>=`: a recall reported on the day of the decision cannot be ordered against it by date alone, so the recheck flags it (the safe direction). Comment that, unlike the Day-0 query in `10_clearance_usl_select.sql`, a CLEAR that a later HOLD or BLOCK has already superseded is not returned.
5. `RUN DQ signed_clear TABLE ...decision` and `RUN DQ known_status TABLE ...decision`.
6. `SHOW DQ INVALID RECORD signed_clear TABLE ...decision` and the same for `known_status`.
7. The DQ-equivalent plain SQL for both rules (`SELECT decision_id, gtin, market, status, contract_id FROM ...decision WHERE NOT (<rule expression>)`), used when DQ does not return within the bounded wait.

### OFF template

`zetaris/templates/off_product_template.sql` documents the per-SKU registration that `gateway/sqlgen.py` generates and the registrar runs (build plan section 3.2, "Per-SKU registration"). It is a template, not a runnable script (the `{gtin13}` placeholder fails the allowlist on purpose), so it lives outside `zetaris/sql/`.

- A header comment: the four steps (1 CREATE the REST table, 2 DESCRIBE it so the generator knows which optional fields exist, 3 CACHE it, 4 re-activate `product` and `declared_allergen` from the full SKU list), the licence and attribution line from `04_off_products_create.sql`, at least 2.5 s between statements that call Open Food Facts (CREATE and CACHE; DESCRIBE makes no source call), the User-Agent placeholder replaced from `CLEARSHELF_USER_AGENT`, and the rule that an optional field missing from DESCRIBE is emitted as `CAST(NULL AS STRING)` because a direct reference fails with `FIELD_NOT_FOUND`.
- The statements, each ending in `;`, with `{gtin13}` as the only placeholder: the `CREATE LIGHTNING REST TABLE off_{gtin13} ...` statement, `DESCRIBE clearshelf_off.off_{gtin13}`, `CACHE TABLE clearshelf_off.off_{gtin13}`, `SELECT COUNT(*) AS n FROM clearshelf_off.off_{gtin13}` (expects 1), the `product` branch for a record that has every optional field, and the `declared_allergen` `contains` branch for market UK. Substituting a GTIN must give exactly what `sqlgen.create_off_table`, `sqlgen.product_branch` and `sqlgen.declared_branch` return for it (all optional fields present), apart from whitespace.
- Step 4 is described in a comment only (the activation is one `UNION ALL` over every SKU, generated by `sqlgen`).

### DQ rule docs

`zetaris/dq-rules.md` lists every rule from `data/curation/zetaris/list_dq_2026-10-23.json` (9 primary-key, 8 foreign-key, 3 custom) plus the two pair-14 rules, marked "registered by `14_decision_writeback_create.sql`; not in the Day-0 listing". For each rule: name, table, type, the expression (custom rules) or the key column and referenced table (PK and FK rules, from the `10_` DDL), what an invalid record means for ClearShelf, and the gateway template ids that read it (from `gateway/templates.py`; write "none yet" where there is none). Also:

- Rule names are column names, so `gtin` and `market_code` each name several rules: always give the table (`RUN DQ gtin TABLE ...recall_product_link`).
- The DQ gate on CLEAR (build plan section 3.3): a CLEAR or CLEAR_WITH_STATEMENT may not be proposed while `has_ingredients`, `english_label`, or the `market_code` foreign key on `declared_allergen` or `extracted_allergen` returns an invalid record for the GTIN; the decision is then HOLD under policy rule R3, quoting the rule name.
- Bounded waits: the gateway waits 60 s per template, the runner 120 s for RUN/SHOW DQ. If DQ does not answer, the gateway runs the equivalent plain SQL and labels the evidence "DQ-equivalent SQL".
- The Day-0 results table copied from `zetaris/README.md`, with its date. No other numbers: every count in the file comes from `zetaris/README.md` or the saved LIST DQ file.

## Constraints

- **Do not edit pairs 00 to 13**, the `GENERATED` blocks, any file in `gateway/` other than the new test file, or any existing test. In `zetaris/manifest.json` and `zetaris/README.md`, insert only what Deliverables says; do not reformat or rewrite the rest of either file. If a check exposes a problem in existing SQL, the allowlist or the splitter, report it; do not loosen or work around it.
- Do not connect to Zetaris and do not call any source API. `run_sql --dry-run` is the only runner use.
- Lightning SQL only, one statement per call, qualified names, no trailing semicolon after splitting. Every object is `clearshelf_*` or `lightning.metastore.clearshelf.*`.
- Never invent a rule name, count, column or result. Names come from the LIST DQ file and the `10_` DDL; counts come from `zetaris/README.md`.
- No credentials, no contact e-mail, no Open Food Facts ingredient text in any committed file, including test fixtures.

## Checks

- `.venv/Scripts/python -m pytest gateway/tests/test_sql_scripts.py` is green. The tests must hold for any number of OFF SKUs in `04_` and `11_` (both files are regenerated from the intake manifest), so never hard-code the Day-0 three. They assert:
  - every file in `zetaris/sql/` is named `NN_<name>_create.sql` or `NN_<name>_select.sql` and has its partner;
  - every `_create.sql` is the `script` of exactly one entry in `zetaris/manifest.json`; every `script` path exists; ids are unique; every `requires` id exists; the dependency graph has no cycle; the `00_` entry is the only one with no requirements;
  - every statement of every `_select.sql` (split with `gateway.jdbc.split_statements`) passes `gateway.allowlist.check(s, "reader")`, and every statement of `14_decision_writeback_create.sql` passes `check(s, "onboard")`;
  - no statement ends with `;`;
  - `10_clearance_usl_create.sql` yields exactly one `COMPILE USL` statement with nine `CREATE TABLE`, with the primary and foreign keys in the table below;
  - every `DESCRIBE BY` text matches `^[A-Za-z0-9 _.,-]+$`; every `user-agent` header value is exactly `YOUR_APP_NAME YOUR_CONTACT_EMAIL`; no SQL file contains `@`;
  - no statement (after splitting, so comments are excluded) contains `address_1`, `address_2`, `postal_code`, an Open Food Facts contributor field (`creator`, `last_editor`, `editors_tags`, `informers_tags`, `correctors_tags`, `photographers_tags`, `checkers_tags`), or any of `DROP`, `GRANT`, `REVOKE`, `INVALIDATE CACHE`, `8889`;
  - every dotted object name directly after `FROM`, `JOIN` or `TABLE` starts with `clearshelf_` or `lightning.metastore.clearshelf` (undotted names such as the `CREATE TABLE` names inside `COMPILE USL`, the `off_<gtin13>` name in `CREATE LIGHTNING REST TABLE` and `SET TABLE DESCRIPTION` are not object references), and every REST table is created `FROM CLEARSHELF_*`;
  - in `11_clearance_usl_activate_create.sql`: all nine tables are activated; every NOT NULL column of the `10_` DDL is, in every activation and every `UNION ALL` branch, `COALESCE(...) AS <column>` or a quoted literal `AS <column>`; every ops activation (`market_allergen`, `extracted_allergen`, `recall_product_link`, `decision`) uses `LATERAL VIEW explode(data) x AS d` and filters `d.<pk> <> '__schema__'`;
  - the three `REGISTER DQ` expressions in `12_` and the two in `14_` are exactly the texts in the build plan and in "Pair 14" above;
  - the template: `{gtin13}` is its only placeholder; for every GTIN that has a `CREATE LIGHTNING REST TABLE` in `04_off_products_create.sql`, the substituted CREATE, DESCRIBE and CACHE statements occur in `04_` (whitespace-normalised), and the substituted CREATE, product branch and declared branch equal the `sqlgen` output for that GTIN;
  - `zetaris/dq-rules.md` names every rule in the LIST DQ file together with its table, and both pair-14 rules.
- `.venv/Scripts/python -m pytest gateway/tests` is still green (live tests stay skipped unless `CLEARSHELF_LIVE=1`). If a test outside this task fails because of other work in progress, report it and leave it.
- `.venv/Scripts/python -m gateway.run_sql <file> --dry-run` exits 0 for every file in `zetaris/sql/`, including both 14 files.
- `cd agent && npm test` still passes (no agent changes expected).

### clearance_usl keys (fixed; the test asserts them against the `10_` DDL)

| Table | Primary key | Foreign keys |
|---|---|---|
| `market_allergen` | `market_code` | |
| `product` | `gtin` | |
| `declared_allergen` | `declared_key` | `gtin` -> product, `market_code` -> market_allergen |
| `extracted_allergen` | `extracted_key` | `gtin` -> product, `market_code` -> market_allergen |
| `fda_recall` | `recall_number` | |
| `fsa_alert` | `notation` | |
| `fsa_alert_allergen` | `alert_allergen_key` | `notation` -> fsa_alert |
| `recall_product_link` | `link_key` | `recall_number` -> fda_recall, `gtin` -> product |
| `decision` | `decision_id` | `gtin` -> product |

## Out of scope

Running any script against the instance (the owner of the SQL runs pair 14 and records the result); changing pairs 00 to 13; `gateway/*.py` (including wiring the new queries into `gateway/templates.py`), the registrar, `gateway/onboard.py` and the ops nginx container; writing any decision.

## Commit

`C2: decision write-back SQL, OFF template, DQ rule docs and static SQL tests (Cursor Agent)`

## Run record (2026-10-23)

Cursor Agent CLI 2026.10.22, model `Auto`, headless, workspace = this repository with the getting-started clone as an extra root. Wall time 295.4 s, exit code 0; 94,992 input tokens, 17,356 output tokens. It wrote `test_sql_scripts.py` first (6 of 13 tests failing), then the deliverables, and ran the checks until the new file was green: 13 passed, every `zetaris/sql/` file passed `--dry-run`, `npm test` passed. The full gateway suite had 3 failures in `test_sqlgen.py`, from onboarding work in progress outside this task, which it left alone. It did not connect to Zetaris and did not commit.

Commit `C2: decision write-back SQL, OFF template, DQ rule docs and static SQL tests (Cursor Agent)` holds Cursor Agent's files unchanged. Its manifest entry and README lines were inserted into files another task was rewriting at the same time, so only those insertions were committed.

Review findings Cursor Agent reported on pairs 00 to 13 (no files changed):

- The `10_` description of `decision.status` lists RELEASE, which is not one of the four decision states.
- The `10_` description of `fda_recall.recall_number` gives only an `H-` example; openFDA also uses `F-`.
- The Day-0 closed-loop query in `10_clearance_usl_select.sql` misses a recall reported on the day of the decision and returns CLEAR rows that a later decision superseded; pair 14 holds the corrected form.
- `12_clearance_dq_select.sql` has no plain-SQL equivalents for `known_relation`, the `market_code` foreign key on `extracted_allergen` or the `gtin` foreign key on `recall_product_link`.

Reviewer changes, in a separate commit:

- `signed_clear` also covers RELEASE: a row written with that status must carry its signed contract too. `known_status` keeps the four decision states.
- The current-decision query joins `product` with a LEFT JOIN, so a decision on a GTIN that left the catalogue is still listed.
- The rule-coverage test no longer reads the gitignored LIST DQ file: it derives the 22 expected rules from the `10_` keys and the `12_`/`14_` registrations. A separate test compares the saved LIST DQ output with them and skips when the file is absent.
- The REST `FROM CLEARSHELF_*` assertion now captures any database name (the first version could not fail).
- `dq-rules.md` lists all five Day-0 DQ results.

Run against the local instance afterwards (pair 14 only): both `REGISTER DQ` statements succeeded (234 ms, 151 ms); `LIST DQ USL` returned 22 rules; write-back parity 0 = 0; the current-decision and recheck queries ran (0 rows); `RUN DQ` on both rules returned 0 / 0 / 0. No decision has been written yet, so the queries have run but their logic has not yet met a real decision row.
