# C2: Lightning SQL scripts and the clearance_usl model

## Goal

Every Zetaris object ClearShelf needs is declared as a committed `_create.sql` / `_select.sql` pair in `zetaris/sql/`, listed in `zetaris/manifest.json` with its dependencies, and checked by tests: the four Lightning databases and the USL namespace, the openFDA, UK FSA and ops REST tables, the per-SKU Open Food Facts template, the `clearance_usl` model with descriptions, its activations, and the DQ rules.

## Workspace

This repository. Pass the getting-started clone as a read-only extra root for its SQL guides: `--add-dir <path to the getting-started clone>`.

## Read first

- `AGENTS.md`, `.cursor/rules/zetaris.mdc`, `.cursor/rules/data-licences.mdc`.
- In the getting-started clone: `AGENTS.md` ("Writing SQL"), `docs/guides/zetaris-lightning-sql-companion.md` (sections 2, 4, 5 and 8), `docs/guides/zetaris-lightning-sql-commands.md` (sections 6, 13, 14 and 19), `open_data/usl/sql/02_sic_edgar_usl_create.sql` (the USL pattern) and `open_data/rest_apis/sql/rate_limited/03_open_food_facts_live_create.sql` (the verified Open Food Facts REST pattern).
- `zetaris/README.md` for the Day-0 gate results (row counts, what worked, fallbacks taken).
- Existing files in `zetaris/sql/` (00 to 02 were written during the Day-0 gates). Review and complete them; do not rewrite statements that the gates verified.

## Inputs

Saved source responses, gitignored, never committed and never quoted into committed files:

- `data/curation/raw/fda_enforcement_undeclared.json` (openFDA, `{meta, results[]}`, 1,000 results)
- `data/curation/raw/fsa_allergy_alerts.json` (FSA, `{meta, items[]}` with `problem[].allergen[]`, 200 items)
- One saved Open Food Facts product response under `data/curation/` (fields `code, product_name, brands, lang, ingredients_text, ingredients_text_en, allergens_tags, traces_tags, labels_tags, countries_tags, last_modified_t`)

Use them only to confirm field names and nesting. Do not call the source APIs.

## Deliverables

| File | Contents |
|---|---|
| `zetaris/sql/00_clearshelf_base_create.sql` / `_select.sql` | `CREATE LIGHTNING DATABASE` for `CLEARSHELF_OFF`, `CLEARSHELF_FDA`, `CLEARSHELF_FSA`, `CLEARSHELF_OPS`; `CREATE SCHEMASTORE CONTAINER clearshelf`; `CREATE NAMESPACE IF NOT EXISTS lightning.metastore` and `lightning.metastore.clearshelf`. Select: `SHOW LIGHTNING DATABASES`, `SHOW NAMESPACES OR TABLES IN lightning.metastore`. |
| `zetaris/sql/01_fda_enforcement_*` | REST table `enforcement_undeclared FROM CLEARSHELF_FDA` on `https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000`, then `CACHE TABLE`. Select: the explode count (must equal 1000) and a sample. |
| `zetaris/sql/02_fsa_allergy_alerts_*` | REST table `allergy_alerts FROM CLEARSHELF_FSA` on `https://data.food.gov.uk/food-alerts/id?type=AA&_sort=-created&_limit=200`, then `CACHE TABLE`. Select: the item count (200) and the double-explode allergen count. If the gate fell back to the mirror, follow `zetaris/README.md`. |
| `zetaris/sql/03_ops_tables_*` | REST tables `market_allergens`, `decisions`, `recall_links`, `extractions` `FROM CLEARSHELF_OPS` on `http://clearshelf-ops/<name>.json` (shape `{"data":[...]}`), **not cached**. Select: sentinel-filtered counts. |
| `zetaris/sql/04_off_product_template_*` | The per-SKU template `off_<gtin13> FROM CLEARSHELF_OFF` on `https://world.openfoodfacts.org/api/v2/product/<gtin13>.json?fields=...` (fields above), then `CACHE TABLE clearshelf_off.off_<gtin13>`, with `<gtin13>` as the only placeholder. `gateway/sqlgen.py` fills it; this file is the reviewed template. Select: `DESCRIBE` and a 1-row read. |
| `zetaris/sql/10_clearance_usl_*` | `COMPILE USL IF NOT EXISTS clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL ...` as ONE statement with the nine tables below, followed by `UPDATE USL ... SET DESCRIPTION` for the USL, every table and every key column. Select: `LOAD USL` and `SHOW NAMESPACES OR TABLES IN lightning.metastore.clearshelf`. |
| `zetaris/sql/11_clearance_usl_activate_*` | `ACTIVATE USL TABLE` for `fda_recall`, `fsa_alert`, `fsa_alert_allergen`, `market_allergen`, `extracted_allergen`, `recall_product_link`, `decision`. (`product` and `declared_allergen` are generated per manifest by `gateway/sqlgen.py`.) Select: a count per activated table, the join-map query and the closed-loop recheck query. |
| `zetaris/sql/12_clearance_dq_*` | `REGISTER DQ` for `has_ingredients`, `english_label`, `known_relation`. Select: `LIST DQ USL lightning.metastore.clearshelf.clearance_usl`, `SHOW DQ INVALID RECORD` for each gate rule, and the plain-SQL equivalents labelled "DQ-equivalent SQL". |
| `zetaris/manifest.json` | One entry per pair with `requires` (00 before everything; 01 to 04 before 10; 10 before 11 and 12), in the getting-started manifest style. |
| `gateway/tests/test_sql_scripts.py` | Static checks over every file in `zetaris/sql/` (see Checks). |
| `zetaris/README.md` | A short section per new pair: purpose, source URL, licence, expected counts. Keep the gate results already recorded there. |

### clearance_usl tables (keys are fixed; columns as in the build plan)

| Table | Primary key | Foreign keys | Activated from |
|---|---|---|---|
| `market_allergen` | `market_code` (e.g. `UK:milk`, `US:wheat`) | | ops `market_allergens` |
| `product` | `gtin` | | generated (OFF tables) |
| `declared_allergen` | `declared_key` | `gtin` -> product, `market_code` -> market_allergen | generated (OFF tables) |
| `extracted_allergen` | `extracted_key` | `gtin` -> product, `market_code` -> market_allergen | ops `extractions` |
| `fda_recall` | `recall_number` | | FDA table, `explode(results)` |
| `fsa_alert` | `notation` | | FSA table, `explode(items)` |
| `fsa_alert_allergen` | `alert_allergen_key` (`notation|lower(label)`) | `notation` -> fsa_alert | FSA table, triple explode items, problem, allergen |
| `recall_product_link` | `link_key` | `recall_number` -> fda_recall, `gtin` -> product | ops `recall_links` |
| `decision` | `decision_id` | `gtin` -> product | ops `decisions` |

The agreed DDL (column names, types and keys are fixed; send it as one statement):

```sql
COMPILE USL IF NOT EXISTS clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL
CREATE TABLE market_allergen (
    market_code varchar(40) NOT NULL PRIMARY KEY,
    market varchar(2) NOT NULL,
    allergen varchar(30) NOT NULL,
    display_name varchar(80),
    statute varchar(200),
    edition varchar(80),
    citation_url varchar(300)
);
CREATE TABLE product (
    gtin varchar(14) NOT NULL PRIMARY KEY,
    product_name varchar(300),
    brand varchar(200),
    lang varchar(8),
    ingredients_text varchar(8000),
    ingredients_text_en varchar(8000),
    labels varchar(2000),
    vegan_claim varchar(3),
    last_modified varchar(20),
    source_url varchar(300)
);
CREATE TABLE declared_allergen (
    declared_key varchar(120) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market_code varchar(40) NOT NULL FOREIGN KEY REFERENCES market_allergen(market_code),
    relation varchar(12) NOT NULL,
    source_tag varchar(60)
);
CREATE TABLE extracted_allergen (
    extracted_key varchar(160) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market_code varchar(40) NOT NULL FOREIGN KEY REFERENCES market_allergen(market_code),
    relation varchar(16) NOT NULL,
    evidence_text varchar(400),
    verifier varchar(16),
    run_id varchar(40)
);
CREATE TABLE fda_recall (
    recall_number varchar(20) NOT NULL PRIMARY KEY,
    report_date varchar(10) NOT NULL,
    classification varchar(12),
    status varchar(12),
    firm varchar(200),
    distribution varchar(1000),
    product_description varchar(4000),
    reason varchar(2000),
    code_info varchar(2000)
);
CREATE TABLE fsa_alert (
    notation varchar(20) NOT NULL PRIMARY KEY,
    created varchar(10) NOT NULL,
    title varchar(400),
    business varchar(200),
    alert_url varchar(300)
);
CREATE TABLE fsa_alert_allergen (
    alert_allergen_key varchar(80) NOT NULL PRIMARY KEY,
    notation varchar(20) NOT NULL FOREIGN KEY REFERENCES fsa_alert(notation),
    allergen_label varchar(60) NOT NULL
);
CREATE TABLE recall_product_link (
    link_key varchar(60) NOT NULL PRIMARY KEY,
    recall_number varchar(20) NOT NULL FOREIGN KEY REFERENCES fda_recall(recall_number),
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    raw_code varchar(40),
    transform varchar(30),
    extracted_by varchar(20)
);
CREATE TABLE decision (
    decision_id varchar(60) NOT NULL PRIMARY KEY,
    gtin varchar(14) NOT NULL FOREIGN KEY REFERENCES product(gtin),
    market varchar(2) NOT NULL,
    status varchar(24) NOT NULL,
    statement varchar(1000),
    decided_at varchar(25) NOT NULL,
    decided_date varchar(10) NOT NULL,
    actor varchar(60),
    contract_id varchar(60),
    reason varchar(1000)
)
```

The agreed source activations (raw tables, not views; confirm every field name against the saved samples):

```sql
ACTIVATE USL TABLE lightning.metastore.clearshelf.clearance_usl.fda_recall AS
SELECT COALESCE(r.recall_number,'') AS recall_number,
       COALESCE(concat(substr(r.report_date,1,4),'-',substr(r.report_date,5,2),'-',substr(r.report_date,7,2)),'') AS report_date,
       r.classification, r.status, r.recalling_firm AS firm, r.distribution_pattern AS distribution,
       r.product_description, r.reason_for_recall AS reason, r.code_info
FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r

ACTIVATE USL TABLE lightning.metastore.clearshelf.clearance_usl.fsa_alert AS
SELECT COALESCE(a.notation,'') AS notation, COALESCE(substr(a.created,1,10),'') AS created,
       a.title, a.reportingBusiness.commonName AS business, a.alertURL AS alert_url
FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a

ACTIVATE USL TABLE lightning.metastore.clearshelf.clearance_usl.fsa_alert_allergen AS
SELECT DISTINCT concat(a.notation,'|',lower(al.label)) AS alert_allergen_key,
       COALESCE(a.notation,'') AS notation, COALESCE(al.label,'') AS allergen_label
FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a
     LATERAL VIEW explode(a.problem) y AS p LATERAL VIEW explode(p.allergen) z AS al
```

Write the four ops activations (`market_allergen`, `extracted_allergen`, `recall_product_link`, `decision`) in the same style from `clearshelf_ops.<name>`, with `LATERAL VIEW explode(data) x AS d` and the sentinel filter.

The two `_select.sql` queries that must be present in `11_clearance_usl_activate_select.sql`:

```sql
SELECT l.transform, COUNT(*) AS links, COUNT(p.gtin) AS in_catalogue
FROM lightning.metastore.clearshelf.clearance_usl.recall_product_link l
LEFT JOIN lightning.metastore.clearshelf.clearance_usl.product p ON l.gtin = p.gtin
GROUP BY l.transform

SELECT d.gtin, d.market, d.status, d.decided_date, f.recall_number, f.report_date, f.classification, f.status AS recall_status
FROM lightning.metastore.clearshelf.clearance_usl.decision d
JOIN lightning.metastore.clearshelf.clearance_usl.recall_product_link l ON d.gtin = l.gtin
JOIN lightning.metastore.clearshelf.clearance_usl.fda_recall f ON l.recall_number = f.recall_number
WHERE d.status IN ('CLEAR','CLEAR_WITH_STATEMENT') AND f.report_date > d.decided_date
```

### DQ rules (exact expressions)

- `has_ingredients` on `product`: `ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0`
- `english_label` on `product`: `lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0)`
- `known_relation` on `extracted_allergen`: `relation IN ('contains','may_contain','free_from_claim','not_allergen')`

## Constraints

- Lightning SQL only; one statement per call; no trailing semicolons after splitting; qualified names; the multi-table `COMPILE USL` stays one statement.
- `DESCRIBE BY` text uses only letters, digits, spaces and `_ . - ,`.
- `COALESCE` on every NOT NULL column in every activation; ops activations use `LATERAL VIEW explode(data) x AS d` and `WHERE d.<pk> <> '__schema__'`.
- The `user-agent` header value is the placeholder `YOUR_APP_NAME YOUR_CONTACT_EMAIL`, replaced at run time from `CLEARSHELF_USER_AGENT`. Never a real or invented contact.
- Never select `address_1`, `address_2`, `postal_code` or any Open Food Facts contributor field.
- Only `CLEARSHELF_*` databases, the `clearshelf` container and `lightning.metastore.clearshelf`. No `DROP`, `GRANT`, `REVOKE`, `INVALIDATE CACHE`, nothing on port 8889.
- Do not run any `_create.sql` against the instance. Dry-run only. `_select.sql` files may be run read-only for objects that already exist.

## Checks

- `.venv/Scripts/python -m pytest gateway/tests/test_sql_scripts.py`. The test splits every file with the gateway's splitter and asserts: every statement passes `gateway/allowlist.py` for the onboarding role; `COMPILE USL` comes out as exactly one statement containing nine `CREATE TABLE`; no statement ends with `;`; `DESCRIBE BY` text matches `^[A-Za-z0-9 _.,-]+$`; no forbidden column or keyword appears; every object name is in the ClearShelf scope; every file in `zetaris/sql/` is in `zetaris/manifest.json` and every manifest dependency exists.
- `.venv/Scripts/python -m gateway.run_sql <each new _create.sql> --dry-run` prints the statement list without errors.
- `cd agent && npm test` still passes (no agent changes expected).

## Out of scope

Running create scripts, `gateway/sqlgen.py`, the registrar, and the ops nginx container.

## Commit

`C2: Lightning SQL scripts and clearance_usl model (Cursor Agent)`
