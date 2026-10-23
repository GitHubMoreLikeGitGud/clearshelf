# Zetaris objects for ClearShelf

Lightning SQL for every Zetaris object ClearShelf uses, as `NN_*_create.sql` / `NN_*_select.sql` pairs listed in [`manifest.json`](manifest.json) in onboarding order. One statement per call, no trailing semicolon. `COMPILE USL` is sent as one statement.

## Onboarding

`gateway/onboard.py` onboards everything in order: the base objects, the openFDA and FSA feeds, the ops tables, one Open Food Facts table per SKU in `data/manifest/skus.json`, the USL, the recall links, the activations and the DQ rules, then records the counts below. It checks what already exists first (SHOW / LIST and the driver's Spark UI, no source calls), so a rerun with `--skip-exists` only does what is missing. Dry-run first:

```bash
.venv/Scripts/python -m gateway.onboard --dry-run --skip-exists
.venv/Scripts/python -m gateway.onboard --skip-exists
```

- Per SKU: `CREATE LIGHTNING REST TABLE`, `DESCRIBE` (which optional fields the record has), `CACHE TABLE`. Statements that call Open Food Facts are 5 s apart by default (`--off-gap`, never below 2.5 s) and are retried twice on failure.
- `product` and `declared_allergen` are generated from the manifest and the `DESCRIBE` output; a missing field becomes `CAST(NULL AS STRING)`. The fields seen are recorded in [`off_describe.json`](off_describe.json) (field names only), so `04_off_products_*.sql` and `11_clearance_usl_activate_create.sql` can be regenerated and checked by the tests.
- An OFF table that is not cached is left out of the activation: every read of the USL would otherwise call Open Food Facts for it.
- Recall links measured at curation time (`recalls[]` in the manifest) are written to `data/ops/recall_links.json` with `extracted_by` = `manifest`. openFDA food recall numbers start with H- or F-; both are accepted.
- `--roles demo` onboards the demo SKUs only; `--gtin` registers one SKU (the activation still covers every registered SKU); `--phases` runs a subset.

Single files can still be run with the statement runner, which splits statements, checks each one against the allowlist and logs it to `data/evidence/sql_log.jsonl`:

```bash
.venv/Scripts/python -m gateway.run_sql zetaris/sql/12_clearance_dq_select.sql --dry-run
.venv/Scripts/python -m gateway.run_sql zetaris/sql/12_clearance_dq_select.sql
```

Without flags, the runner waits at least 3 s between statements that name `world.openfoodfacts.org` or a `clearshelf_off.*` table (`--spacing` can only raise this), bounds `RUN DQ` and `SHOW DQ` at 120 s and everything else at 600 s (`--timeout` overrides), and logs the timeout used with each statement. COUNT queries and `RUN DQ` also log their first result rows.

REST scripts carry the placeholder `YOUR_APP_NAME YOUR_CONTACT_EMAIL`, replaced at run time from `CLEARSHELF_USER_AGENT` in `.env.local`.

| Script | Objects |
|---|---|
| `00_clearshelf_base` | Lightning databases `CLEARSHELF_OFF`, `CLEARSHELF_FDA`, `CLEARSHELF_FSA`, `CLEARSHELF_OPS`; container `clearshelf`; namespace `lightning.metastore.clearshelf` |
| `01_fda_enforcement` | `clearshelf_fda.enforcement_undeclared` (openFDA, cached) |
| `02_fsa_allergy_alerts` | `clearshelf_fsa.allergy_alerts` (UK FSA, cached) |
| `03_ops` | `clearshelf_ops.health`, `.market_allergens`, `.decisions`, `.recall_links`, `.extractions` (never cached) |
| `04_off_products` | `clearshelf_off.off_<gtin13>`, one per manifest SKU (cached); generated |
| `10_clearance_usl` | USL `lightning.metastore.clearshelf.clearance_usl`, nine tables, descriptions; `_select` holds the join queries |
| `11_clearance_usl_activate` | All nine activations; generated (`product` and `declared_allergen` per SKU by `gateway/sqlgen.py`) |
| `12_clearance_dq` | Custom DQ rules; `_select` runs RUN DQ, SHOW DQ and the plain-SQL equivalents |
| `13_reactivate_probe` | Day-0 probe: re-activation of `product` with a changed query |
| `14_decision_writeback` | DQ rules and read queries for the ops decision write-back |

Every DQ rule is documented in [`dq-rules.md`](dq-rules.md); the per-SKU Open Food Facts registration template is [`templates/off_product_template.sql`](templates/off_product_template.sql).

## Verified counts (Zetaris 2.4.3.1, local Docker)

Each feed was counted in Zetaris and independently from the source response, as in the getting-started REST HOWTO §2 (23 Oct 2026).

| Check | Zetaris | Independent | |
|---|---|---|---|
| openFDA reports (`explode(results)`) | 1,000 | 1,000 (`results` length) | match |
| openFDA report dates | 2023-12-20 to 2026-10-14 | same | match |
| FSA alerts (`explode(items)`) | 200 | 200 (`items` length) | match |
| FSA alert x allergen (double explode) | 349 | 349 (`problem[].allergen[]` count) | match |

### Full onboarding

<!-- onboard:counts:start -->

Full onboarding by `gateway/onboard.py`, 2026-10-23 09:42 UTC+08:00 (Zetaris 2.4.3.1, local Docker): 30 SKUs from `data/manifest/skus.json`. Regenerated on every full run.

OFF tables: 30 registered and cached, 30 of them return exactly 1 row.

| USL table | Rows |
|---|---|
| `market_allergen` | 23 |
| `fda_recall` | 1,000 |
| `fsa_alert` | 200 |
| `product` | 30 |
| `declared_allergen` | 111 |
| `fsa_alert_allergen` | 349 |
| `extracted_allergen` | 0 |
| `recall_product_link` | 14 |
| `decision` | 0 |

| Rule | Table | Total | Valid | Invalid |
|---|---|---|---|---|
| `has_ingredients` | `product` | 30 | 27 | 3 |
| `english_label` | `product` | 30 | 25 | 5 |
| `market_code` | `declared_allergen` | 111 | 105 | 6 |
| `gtin` | `declared_allergen` | 111 | 111 | 0 |
| `known_relation` | `extracted_allergen` | 0 | 0 | 0 |
| `market_code` | `extracted_allergen` | 0 | 0 | 0 |
| `gtin` | `recall_product_link` | 14 | 14 | 0 |
| `recall_number` | `recall_product_link` | 14 | 14 | 0 |

Join map (`recall_product_link` against `product`): `ean13` 3 links, 3 in the catalogue; `upc12_pad13` 11 links, 11 in the catalogue.

`product` ⨝ `recall_product_link` ⨝ `fda_recall` returns 14 rows (recall numbers with prefixes F-, H-).

<!-- onboard:counts:end -->

`SHOW DQ INVALID RECORD` returns the same rows as the plain-SQL equivalents in `12_clearance_dq_select.sql`.

On 23 Oct the Day-0 gate set (three SKUs) gave `product` 3, `declared_allergen` 10, `recall_product_link` 4 (gate seeds), `has_ingredients` 3 / 2 / 1, `english_label` 3 / 1 / 2 and `market_code` 10 / 7 / 3. The gate table `clearshelf_off.off_5000254020408` stays registered but is not in the manifest, so it is no longer activated or warmed.

## Behaviour measured on this instance

- **Caching is driver-wide, not per session.** After `CACHE TABLE` on one JDBC connection, a second connection's count returned in about 0.1 s, and the cache survived the first connection closing. `SHOW CACHE TABLES` returned no rows. The driver's Spark UI storage API (`http://127.0.0.1:4040/api/v1/applications/<app>/storage/rdd`) lists each cached table as `In-memory table <db>.<table>`; the gateway reads it for `cache_state`. A driver restart drops every cache.
- **Cached against uncached.** openFDA count of 1,000 reports: 0.9 to 2.8 s uncached, about 0.1 s cached; `CACHE TABLE` took 0.8 to 1.2 s. FSA count of 200 alerts: 2.1 s uncached, about 0.1 s cached; `CACHE TABLE` took 1.0 to 1.1 s.
- **Refresh.** `UNCACHE TABLE` then `CACHE TABLE` both work on the FDA and FSA tables. The next query after `UNCACHE` re-reads the source.
- **Ops write-back.** An atomic rewrite of a `data/ops/*.json` file is visible on the next query of the uncached REST table.
- **Optional OFF fields.** A record without a field (for example no `brands` on `0816929000119`) has no such struct field, and a direct reference fails with `FIELD_NOT_FOUND`. `gateway/sqlgen.py` reads `DESCRIBE` first and emits `CAST(NULL AS STRING)` instead.
- **NOT NULL keys built with `concat()`** fail activation with `nullable -> NOT NULL`. Every such key is wrapped in `COALESCE(..., '')`.
- **Descriptions.** `UPDATE USL ... SET DESCRIPTION 'text'` stores the quotes as part of the text, so the scripts use unquoted text.
- **Re-activation.** `ACTIVATE USL TABLE` on an active table with a changed query is accepted and takes effect on the next query. Custom DQ rules survive it. Going from 3 to 40 SKUs, `product` (40 branches) activated in 1.2 s and `declared_allergen` (one branch per SKU, market and tag array) in 1.4 s.
- **Cost of the 40-SKU union.** With every table cached, a one-GTIN read of `product` takes about 2.3 s (0.1 to 0.6 s with 3 SKUs), `RUN DQ` on `product` about 5.5 s and on `declared_allergen` 11 to 13 s, all well inside the 60 s and 120 s bounds.
- **Gateway warm-up.** It re-caches only the two feeds and the manifest's OFF tables, once per driver start (a new Spark app id). A reconnect on the same driver does not re-run it, because the cache outlives the session. On the first start after onboarding it found all 42 targets cached and sent no statement.
- **JDBC.** The driver treats a `?` inside a REST endpoint URL as a bind parameter if the statement is prepared. The gateway sends every statement as a plain `java.sql.Statement`.

## Sources and licences

- openFDA food enforcement API: public domain / CC0. No FDA endorsement is implied.
- UK Food Standards Agency food alerts API: contains public sector information licensed under the Open Government Licence v3.0.
- Open Food Facts: data from https://world.openfoodfacts.org/, licensed under the Open Database License (ODbL) 1.0.
