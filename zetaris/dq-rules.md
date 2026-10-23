# Clearance USL data-quality rules

Rules on `lightning.metastore.clearshelf.clearance_usl`, from the Day-0
`LIST DQ USL` saved at `data/curation/zetaris/list_dq_2026-10-23.json`
(20 rows: 9 primary-key, 8 foreign-key, 3 custom) plus the two pair-14
custom rules. Rule names are column names, so `gtin` and `market_code`
each name several rules: always qualify with the table
(`RUN DQ gtin TABLE ...recall_product_link`).

## CLEAR gate (build plan section 3.3)

A CLEAR or CLEAR_WITH_STATEMENT may not be proposed while `has_ingredients`,
`english_label`, or the `market_code` foreign key on `declared_allergen` or
`extracted_allergen` returns an invalid record for the GTIN. The decision is
then HOLD under policy rule R3, quoting the rule name.

## Bounded waits

The gateway waits 60 s per template; the runner waits 120 s for RUN/SHOW DQ.
If DQ does not answer, the gateway runs the equivalent plain SQL and labels
the evidence "DQ-equivalent SQL".

## Day-0 results (23 Oct 2026)

Copied from [`README.md`](README.md). Saved `LIST DQ USL` has 20 rows
(9 primary-key, 8 foreign-key, 3 custom). On 23 Oct the Day-0 gate set
(three SKUs) gave:

| Rule | Table | Total | Valid | Invalid |
|---|---|---|---|---|
| `has_ingredients` | `product` | 3 | 2 | 1 |
| `english_label` | `product` | 3 | 1 | 2 |
| `market_code` (FK) | `declared_allergen` | 10 | 7 | 3 |

USL row counts from the same gate record: `product` 3, `declared_allergen` 10,
`recall_product_link` 4. `SHOW DQ INVALID RECORD` returns the same rows as the
plain-SQL equivalents in `12_clearance_dq_select.sql`.

## Rules

### Primary key

| Name | Table | Key column | Invalid means | Gateway templates |
|---|---|---|---|---|
| `market_code` | `market_allergen` | `market_code` | Duplicate or null statutory key | none yet |
| `gtin` | `product` | `gtin` | Duplicate or null catalogue GTIN | none yet |
| `declared_key` | `declared_allergen` | `declared_key` | Duplicate declared-allergen row | none yet |
| `extracted_key` | `extracted_allergen` | `extracted_key` | Duplicate extraction row | none yet |
| `recall_number` | `fda_recall` | `recall_number` | Duplicate FDA recall | none yet |
| `notation` | `fsa_alert` | `notation` | Duplicate FSA alert | none yet |
| `alert_allergen_key` | `fsa_alert_allergen` | `alert_allergen_key` | Duplicate alert×allergen row | none yet |
| `link_key` | `recall_product_link` | `link_key` | Duplicate recall–product link | none yet |
| `decision_id` | `decision` | `decision_id` | Duplicate decision write-back | none yet |

### Foreign key

| Name | Table | Key column | References | Invalid means | Gateway templates |
|---|---|---|---|---|---|
| `gtin` | `declared_allergen` | `gtin` | `product` | Declared allergen for a GTIN not in the catalogue | none yet |
| `market_code` | `declared_allergen` | `market_code` | `market_allergen` | Tag mapped to a non-statutory `MARKET:allergen`; CLEAR gate (R3) | `dq_invalid_declared_market_code`, `dqsql_declared_market_code` |
| `gtin` | `extracted_allergen` | `gtin` | `product` | Extraction for a GTIN not in the catalogue | none yet |
| `market_code` | `extracted_allergen` | `market_code` | `market_allergen` | Extraction with a non-statutory market_code; CLEAR gate (R3) | `dq_invalid_extracted_market_code`, `dqsql_extracted_market_code` |
| `notation` | `fsa_alert_allergen` | `notation` | `fsa_alert` | Allergen row whose alert is missing | none yet |
| `recall_number` | `recall_product_link` | `recall_number` | `fda_recall` | Link to a recall not in the undeclared feed | none yet |
| `gtin` | `recall_product_link` | `gtin` | `product` | Recalled code not in the catalogue (FK orphan) | none yet |
| `gtin` | `decision` | `gtin` | `product` | Decision for a GTIN not in the catalogue | none yet |

### Custom (Day-0)

| Name | Table | Expression | Invalid means | Gateway templates |
|---|---|---|---|---|
| `has_ingredients` | `product` | `ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0` | No ingredient text; CLEAR gate (R3) | `dq_invalid_has_ingredients`, `dqsql_has_ingredients` |
| `english_label` | `product` | `lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0)` | No English label text; CLEAR gate (R3) | `dq_invalid_english_label`, `dqsql_english_label` |
| `known_relation` | `extracted_allergen` | `relation IN ('contains','may_contain','free_from_claim','not_allergen')` | Extraction with an unknown relation | none yet |

### Custom (pair 14)

Registered by `14_decision_writeback_create.sql`; not in the Day-0 listing.

| Name | Table | Expression | Invalid means | Gateway templates |
|---|---|---|---|---|
| `signed_clear` | `decision` | `status NOT IN ('CLEAR','CLEAR_WITH_STATEMENT') OR (contract_id IS NOT NULL AND length(trim(contract_id)) > 0)` | CLEAR or CLEAR_WITH_STATEMENT without a signed `contract_id` | none yet |
| `known_status` | `decision` | `status IN ('CLEAR','CLEAR_WITH_STATEMENT','HOLD','BLOCK')` | Status outside the four decision states | none yet |
