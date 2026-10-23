"""Generators for the per-SKU Lightning SQL: OFF REST tables and the USL
`product` / `declared_allergen` activations.

Optional OFF fields are only referenced when DESCRIBE shows them in the
`product` struct; a missing field becomes CAST(NULL AS STRING), because a
direct reference fails with FIELD_NOT_FOUND.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

USL = "lightning.metastore.clearshelf.clearance_usl"
OFF_FIELDS = (
    "code,product_name,brands,lang,ingredients_text,ingredients_text_en,"
    "allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t"
)
UA_PLACEHOLDER = "YOUR_APP_NAME YOUR_CONTACT_EMAIL"

# OFF allergen tag -> ClearShelf allergen code. Unmapped tags keep their text
# after the language prefix (de:blé -> blé) and surface as FK DQ orphans.
TAG_MAP = {
    "en:milk": "milk", "en:gluten": "gluten_cereal", "en:nuts": "tree_nut", "en:soybeans": "soy",
    "en:eggs": "egg", "en:sesame-seeds": "sesame", "en:peanuts": "peanut", "en:crustaceans": "crustacean",
    "en:molluscs": "mollusc", "en:fish": "fish", "en:celery": "celery", "en:mustard": "mustard",
    "en:lupin": "lupin", "en:sulphur-dioxide-and-sulphites": "sulphite",
}

_GTIN = re.compile(r"^\d{13}$")
_MARKET = re.compile(r"^(UK|US)$")


def gtin_check_digit_ok(gtin: str) -> bool:
    if not _GTIN.match(gtin):
        return False
    digits = [int(c) for c in gtin]
    total = sum(d * (3 if i % 2 else 1) for i, d in enumerate(digits[:12]))
    return (10 - total % 10) % 10 == digits[12]


def _check_gtin(gtin: str) -> str:
    if not gtin_check_digit_ok(gtin):
        raise ValueError(f"not a valid GTIN-13: {gtin!r}")
    return gtin


def off_table(gtin: str) -> str:
    return f"clearshelf_off.off_{_check_gtin(gtin)}"


def off_endpoint(gtin: str) -> str:
    return f"https://world.openfoodfacts.org/api/v2/product/{_check_gtin(gtin)}.json?fields={OFF_FIELDS}"


def off_source_url(gtin: str) -> str:
    return f"https://world.openfoodfacts.org/product/{_check_gtin(gtin)}"


def create_off_table(gtin: str) -> str:
    return (
        f"CREATE LIGHTNING REST TABLE off_{_check_gtin(gtin)} FROM CLEARSHELF_OFF REQUEST(\n"
        f'    endpoint "{off_endpoint(gtin)}",\n'
        '    method "get",\n'
        '    response_type "json",\n'
        '    http_encoding "URLENCODED"\n'
        ") HEADER (\n"
        f'    user-agent "{UA_PLACEHOLDER}"\n'
        ") BODY ()"
    )


def struct_fields(type_text: str) -> set[str]:
    """Top-level field names of a Spark `struct<...>` type string."""
    t = type_text.strip()
    if not t.startswith("struct<") or not t.endswith(">"):
        return set()
    body, names, depth, start = t[7:-1], set(), 0, 0
    for i, c in enumerate(body + ","):
        if c == "<":
            depth += 1
        elif c == ">":
            depth -= 1
        elif c == "," and depth == 0:
            part = body[start:i]
            if ":" in part:
                names.add(part.split(":", 1)[0].strip().strip("`"))
            start = i + 1
    return names


def product_fields_from_describe(rows: list[list]) -> set[str]:
    """Fields of the `product` struct from `DESCRIBE clearshelf_off.off_<gtin>` rows."""
    for r in rows:
        if r and r[0] == "product":
            return struct_fields(str(r[1]))
    return set()


@dataclass
class Sku:
    gtin: str
    markets: list[str]
    fields: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        _check_gtin(self.gtin)
        for m in self.markets:
            if not _MARKET.match(m):
                raise ValueError(f"market must be UK or US: {m!r}")


def _opt(sku: Sku, name: str, alias: str | None = None) -> str:
    alias = alias or name
    return f"product.{name} AS {alias}" if name in sku.fields else f"CAST(NULL AS STRING) AS {alias}"


def product_branch(sku: Sku) -> str:
    g = sku.gtin
    if "labels_tags" in sku.fields:
        labels = "array_join(product.labels_tags, ',') AS labels"
        vegan = "CASE WHEN array_contains(product.labels_tags, 'en:vegan') THEN 'yes' ELSE 'no' END AS vegan_claim"
    else:
        labels, vegan = "CAST(NULL AS STRING) AS labels", "CAST(NULL AS STRING) AS vegan_claim"
    last_mod = "CAST(product.last_modified_t AS STRING) AS last_modified" if "last_modified_t" in sku.fields else "CAST(NULL AS STRING) AS last_modified"
    cols = [
        f"'{g}' AS gtin",
        _opt(sku, "product_name"),
        _opt(sku, "brands", "brand"),
        _opt(sku, "lang"),
        _opt(sku, "ingredients_text"),
        _opt(sku, "ingredients_text_en"),
        labels,
        vegan,
        last_mod,
        f"'{off_source_url(g)}' AS source_url",
    ]
    return "SELECT " + ", ".join(cols) + f" FROM {off_table(g)}"


def activate_product(skus: list[Sku]) -> str:
    if not skus:
        raise ValueError("no SKUs")
    return f"ACTIVATE USL TABLE {USL}.product AS\n" + "\nUNION ALL\n".join(product_branch(s) for s in skus)


def _case_tag(col: str) -> str:
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TAG_MAP.items())
    return f"CASE {col} {whens} ELSE regexp_replace({col}, '^[a-z]{{2}}:', '') END"


def declared_branch(sku: Sku, market: str, tag_field: str, relation: str) -> str:
    g = sku.gtin
    inner = f"SELECT t, {_case_tag('t')} AS allergen FROM {off_table(g)} LATERAL VIEW explode(product.{tag_field}) x AS t"
    return (
        f"SELECT COALESCE(concat('{g}', '|', '{market}', '|', allergen, '|', '{relation}'), '') AS declared_key, "
        f"'{g}' AS gtin, COALESCE(concat('{market}:', allergen), '') AS market_code, '{relation}' AS relation, min(t) AS source_tag "
        f"FROM ({inner}) s GROUP BY allergen"
    )


def activate_declared(skus: list[Sku]) -> str:
    branches = []
    for s in skus:
        for m in s.markets:
            if "allergens_tags" in s.fields:
                branches.append(declared_branch(s, m, "allergens_tags", "contains"))
            if "traces_tags" in s.fields:
                branches.append(declared_branch(s, m, "traces_tags", "may_contain"))
    if not branches:
        g = skus[0].gtin
        branches.append(
            "SELECT CAST('' AS STRING) AS declared_key, CAST('' AS STRING) AS gtin, CAST('' AS STRING) AS market_code, "
            f"CAST('' AS STRING) AS relation, CAST(NULL AS STRING) AS source_tag FROM {off_table(g)} WHERE 1 = 0"
        )
    return f"ACTIVATE USL TABLE {USL}.declared_allergen AS\n" + "\nUNION ALL\n".join(branches)


# --- activations that do not depend on the SKU list -------------------------

# Parents before the tables whose foreign keys point at them.
ACTIVATION_ORDER = ("market_allergen", "fda_recall", "fsa_alert", "product", "declared_allergen",
                    "fsa_alert_allergen", "extracted_allergen", "recall_product_link", "decision")
# Re-activated whenever SKUs are added: product and declared_allergen are
# generated per SKU, and recall_product_link re-reads the links file.
SKU_TABLES = ("product", "declared_allergen", "recall_product_link")

STATIC_ACTIVATIONS = {
    "market_allergen": f"""ACTIVATE USL TABLE {USL}.market_allergen AS
SELECT COALESCE(d.market_code, '') AS market_code, COALESCE(d.market, '') AS market, COALESCE(d.allergen, '') AS allergen,
       d.display_name, d.statute, d.edition, d.citation_url
FROM clearshelf_ops.market_allergens LATERAL VIEW explode(data) x AS d
WHERE d.market_code <> '__schema__'""",
    "fda_recall": f"""ACTIVATE USL TABLE {USL}.fda_recall AS
SELECT COALESCE(r.recall_number, '') AS recall_number,
       COALESCE(concat(substr(r.report_date, 1, 4), '-', substr(r.report_date, 5, 2), '-', substr(r.report_date, 7, 2)), '') AS report_date,
       r.classification, r.status, r.recalling_firm AS firm, r.distribution_pattern AS distribution,
       r.product_description, r.reason_for_recall AS reason, r.code_info
FROM clearshelf_fda.enforcement_undeclared LATERAL VIEW explode(results) x AS r""",
    "fsa_alert": f"""ACTIVATE USL TABLE {USL}.fsa_alert AS
SELECT COALESCE(a.notation, '') AS notation, COALESCE(substr(a.created, 1, 10), '') AS created,
       a.title, a.reportingBusiness.commonName AS business, a.alertURL AS alert_url
FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a""",
    "fsa_alert_allergen": f"""ACTIVATE USL TABLE {USL}.fsa_alert_allergen AS
SELECT DISTINCT COALESCE(concat(a.notation, '|', lower(al.label)), '') AS alert_allergen_key,
       COALESCE(a.notation, '') AS notation, COALESCE(al.label, '') AS allergen_label
FROM clearshelf_fsa.allergy_alerts LATERAL VIEW explode(items) x AS a
     LATERAL VIEW explode(a.problem) y AS p LATERAL VIEW explode(p.allergen) z AS al""",
    "extracted_allergen": f"""ACTIVATE USL TABLE {USL}.extracted_allergen AS
SELECT COALESCE(d.extracted_key, '') AS extracted_key, COALESCE(d.gtin, '') AS gtin, COALESCE(d.market_code, '') AS market_code,
       COALESCE(d.relation, '') AS relation, d.evidence_text, d.verifier, d.run_id
FROM clearshelf_ops.extractions LATERAL VIEW explode(data) x AS d
WHERE d.extracted_key <> '__schema__'""",
    "recall_product_link": f"""ACTIVATE USL TABLE {USL}.recall_product_link AS
SELECT COALESCE(d.link_key, '') AS link_key, COALESCE(d.recall_number, '') AS recall_number, COALESCE(d.gtin, '') AS gtin,
       d.raw_code, d.transform, d.extracted_by
FROM clearshelf_ops.recall_links LATERAL VIEW explode(data) x AS d
WHERE d.link_key <> '__schema__'""",
    "decision": f"""ACTIVATE USL TABLE {USL}.decision AS
SELECT COALESCE(d.decision_id, '') AS decision_id, COALESCE(d.gtin, '') AS gtin, COALESCE(d.market, '') AS market,
       COALESCE(d.status, '') AS status, d.statement, COALESCE(d.decided_at, '') AS decided_at,
       COALESCE(d.decided_date, '') AS decided_date, d.actor, d.contract_id, d.reason
FROM clearshelf_ops.decisions LATERAL VIEW explode(data) x AS d
WHERE d.decision_id <> '__schema__'""",
}


def activation(table: str, skus: list[Sku]) -> str:
    if table == "product":
        return activate_product(skus)
    if table == "declared_allergen":
        return activate_declared(skus)
    return STATIC_ACTIVATIONS[table]


def off_row_counts(gtins: list[str]) -> str:
    """One statement: the row count of every listed OFF table (each must be 1).
    Run it only on cached tables, or it calls Open Food Facts once per table."""
    if not gtins:
        raise ValueError("no GTINs")
    return "\nUNION ALL\n".join(f"SELECT '{_check_gtin(g)}' AS gtin, COUNT(*) AS n FROM {off_table(g)}" for g in gtins)


# --- committed script files ---------------------------------------------------

def _comment(text: str) -> str:
    return " ".join("".join(c if c.isprintable() else " " for c in text).split())


OFF_CREATE_HEADER = """-- =============================================================================
-- Source: Open Food Facts live product API, one REST table per SKU
-- (clearshelf_off.off_<gtin13>). GENERATED by gateway/onboard.py from
-- data/manifest/skus.json; do not edit by hand.
-- Licence: ODbL 1.0. Data from Open Food Facts (https://world.openfoodfacts.org/),
-- licensed under the Open Database License (ODbL). Attribution required.
-- Pattern: open_data/rest_apis/sql/rate_limited/03_open_food_facts_live_create.sql
-- in the Zetaris getting-started repository (top-level object, product struct).
-- Etiquette: at least 2.5 s between statements that call OFF (CREATE, CACHE;
-- onboarding uses 5 s), with an identifying User-Agent from CLEARSHELF_USER_AGENT.
-- Per SKU: CREATE, DESCRIBE (which optional fields exist; no source call), CACHE.
-- =============================================================================
"""


def off_create_script(entries: list[tuple[str, str]]) -> str:
    """04_off_products_create.sql for (gtin, comment) entries in manifest order."""
    parts = [OFF_CREATE_HEADER]
    for g, note in entries:
        parts.append(f"\n-- {_comment(note)}\n{create_off_table(g)};\n\nDESCRIBE {off_table(g)};\n\nCACHE TABLE {off_table(g)};\n")
    return "".join(parts)


def off_select_script(gtins: list[str]) -> str:
    return ("-- Verification for 04_off_products_create.sql (GENERATED by gateway/onboard.py):\n"
            "-- each OFF table returns exactly 1 row. Run only after CACHE TABLE, so the\n"
            "-- count reads the cache instead of calling Open Food Facts.\n\n"
            f"{off_row_counts(gtins)};\n")


ACTIVATE_HEADER = """-- =============================================================================
-- Activations for clearance_usl, in dependency order: parents (market_allergen,
-- fda_recall, fsa_alert, product) before the tables whose foreign keys point
-- at them. Every activation reads the raw REST tables, with COALESCE on every
-- NOT NULL column. Firm street addresses are never selected.
-- GENERATED by gateway/onboard.py: product and declared_allergen come from
-- gateway/sqlgen.py, the intake manifest and the DESCRIBE output recorded in
-- zetaris/off_describe.json. Optional OFF fields missing from a record are
-- emitted as CAST(NULL AS STRING).
-- Ops tables (market_allergen, extracted_allergen, recall_product_link,
-- decision) filter out the "__schema__" sentinel row.
-- =============================================================================
"""


def activation_script(skus: list[Sku]) -> str:
    """11_clearance_usl_activate_create.sql: all nine activations."""
    parts = [ACTIVATE_HEADER]
    for t in ACTIVATION_ORDER:
        tag = "-- GENERATED by gateway/sqlgen.py\n" if t in ("product", "declared_allergen") else ""
        parts.append(f"\n{tag}{activation(t, skus)};\n")
    return "".join(parts)
