"""Named read templates. The agent sends a template id and parameters, never SQL.

Parameters are validated by regex (and GTIN check digit) before they are
substituted, so a value can only ever be a GTIN, a notice id, a market code,
a date or a lower-case brand token.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .sqlgen import gtin_check_digit_ok

U = "lightning.metastore.clearshelf.clearance_usl"
FDA_RAW = "clearshelf_fda.enforcement_undeclared"
FSA_RAW = "clearshelf_fsa.allergy_alerts"
OPS_RAW = {
    "market_allergen": "clearshelf_ops.market_allergens",
    "decision": "clearshelf_ops.decisions",
    "recall_product_link": "clearshelf_ops.recall_links",
    "extracted_allergen": "clearshelf_ops.extractions",
}
OFF_RAW = "clearshelf_off.off_*"

PARAM_PATTERNS = {
    "gtin": re.compile(r"^\d{13}$"),
    "fda_notice": re.compile(r"^[FH]-\d{4}-\d{4}$"),  # openFDA food recall numbers use both prefixes
    "fsa_notice": re.compile(r"^FSA-AA-\d+-\d{4}$"),
    "brand": re.compile(r"^[a-z0-9 ]{1,40}$"),
    "market": re.compile(r"^(UK|US)$"),
    "date": re.compile(r"^\d{4}-\d{2}-\d{2}$"),
}


class BadParams(ValueError):
    pass


@dataclass(frozen=True)
class Template:
    id: str
    sql: str
    params: dict[str, str]
    objects: tuple[str, ...]
    raw_objects: tuple[str, ...]
    description: str = ""


def _t(id: str, sql: str, params: dict[str, str], objects: tuple[str, ...], raw: tuple[str, ...], description: str) -> Template:
    return Template(id, " ".join(sql.split()), params, objects, raw, description)


TEMPLATES: dict[str, Template] = {
    t.id: t
    for t in [
        _t("select_one", "SELECT 1 AS ok", {}, (), (), "Connectivity check."),
        _t(
            "product",
            f"SELECT gtin, product_name, brand, lang, ingredients_text, ingredients_text_en, labels, vegan_claim, last_modified, source_url FROM {U}.product WHERE gtin = '{{gtin}}'",
            {"gtin": "gtin"}, (f"{U}.product",), (OFF_RAW,), "The USL product row for a GTIN.",
        ),
        _t(
            "declared",
            f"SELECT d.declared_key, d.market_code, d.relation, d.source_tag, m.display_name FROM {U}.declared_allergen d "
            f"LEFT JOIN {U}.market_allergen m ON d.market_code = m.market_code WHERE d.gtin = '{{gtin}}' ORDER BY d.market_code, d.relation",
            {"gtin": "gtin"}, (f"{U}.declared_allergen", f"{U}.market_allergen"), (OFF_RAW, OPS_RAW["market_allergen"]),
            "Declared allergens for a GTIN; display_name is null for a market_code with no statutory match.",
        ),
        _t(
            "recalls_by_gtin",
            f"SELECT l.link_key, l.raw_code, l.transform, l.extracted_by, f.recall_number, f.report_date, f.classification, f.status, f.firm, "
            f"f.distribution, f.product_description, f.reason, f.code_info FROM {U}.recall_product_link l "
            f"JOIN {U}.fda_recall f ON l.recall_number = f.recall_number WHERE l.gtin = '{{gtin}}' ORDER BY f.report_date DESC",
            {"gtin": "gtin"}, (f"{U}.recall_product_link", f"{U}.fda_recall"), (OPS_RAW["recall_product_link"], FDA_RAW),
            "FDA recalls linked to a GTIN.",
        ),
        _t(
            "recalls_by_name",
            f"SELECT 'fda' AS source, f.recall_number AS notice_id, f.report_date AS notice_date, f.firm AS business, "
            f"substr(f.product_description, 1, 400) AS title FROM {U}.fda_recall f "
            f"WHERE lower(f.firm) LIKE '%{{brand}}%' OR lower(f.product_description) LIKE '%{{brand}}%' "
            f"UNION ALL SELECT 'fsa' AS source, a.notation AS notice_id, a.created AS notice_date, a.business, a.title "
            f"FROM {U}.fsa_alert a WHERE lower(a.title) LIKE '%{{brand}}%' OR lower(a.business) LIKE '%{{brand}}%'",
            {"brand": "brand"}, (f"{U}.fda_recall", f"{U}.fsa_alert"), (FDA_RAW, FSA_RAW),
            "FDA recalls and FSA alerts whose firm, description, title or business contains a brand token.",
        ),
        _t(
            "fda_notice",
            f"SELECT recall_number, report_date, classification, status, firm, distribution, product_description, reason, code_info "
            f"FROM {U}.fda_recall WHERE recall_number = '{{recall_number}}'",
            {"recall_number": "fda_notice"}, (f"{U}.fda_recall",), (FDA_RAW,), "One FDA recall.",
        ),
        _t(
            "fda_recent",
            f"SELECT recall_number, report_date, classification, status, firm FROM {U}.fda_recall WHERE report_date >= '{{since}}' ORDER BY report_date DESC",
            {"since": "date"}, (f"{U}.fda_recall",), (FDA_RAW,), "FDA recalls reported on or after a date.",
        ),
        _t(
            "fsa_recent",
            f"SELECT notation, created, title, business, alert_url FROM {U}.fsa_alert WHERE created >= '{{since}}' ORDER BY created DESC",
            {"since": "date"}, (f"{U}.fsa_alert",), (FSA_RAW,), "FSA allergy alerts created on or after a date.",
        ),
        _t(
            "fsa_allergens",
            f"SELECT notation, allergen_label FROM {U}.fsa_alert_allergen WHERE notation = '{{notation}}' ORDER BY allergen_label",
            {"notation": "fsa_notice"}, (f"{U}.fsa_alert_allergen",), (FSA_RAW,), "Allergens on one FSA alert.",
        ),
        _t(
            "market_list",
            f"SELECT market_code, allergen, display_name, statute, edition, citation_url FROM {U}.market_allergen WHERE market = '{{market}}' ORDER BY allergen",
            {"market": "market"}, (f"{U}.market_allergen",), (OPS_RAW["market_allergen"],), "The statutory allergen list for a market.",
        ),
        _t(
            "prior_decisions",
            f"SELECT decision_id, gtin, market, status, statement, decided_at, decided_date, actor, contract_id, reason "
            f"FROM {U}.decision WHERE gtin = '{{gtin}}' ORDER BY decided_at DESC",
            {"gtin": "gtin"}, (f"{U}.decision",), (OPS_RAW["decision"],), "Earlier decisions for a GTIN.",
        ),
        _t(
            "recheck_cleared",
            f"SELECT d.gtin, d.market, d.status, d.decided_date, f.recall_number, f.report_date, f.classification, f.status AS recall_status "
            f"FROM {U}.decision d JOIN {U}.recall_product_link l ON d.gtin = l.gtin JOIN {U}.fda_recall f ON l.recall_number = f.recall_number "
            f"WHERE d.status IN ('CLEAR','CLEAR_WITH_STATEMENT') AND f.report_date > d.decided_date",
            {}, (f"{U}.decision", f"{U}.recall_product_link", f"{U}.fda_recall"),
            (OPS_RAW["decision"], OPS_RAW["recall_product_link"], FDA_RAW),
            "Cleared decisions with a newer recall for the same GTIN (closed-loop recheck).",
        ),
        _t(
            "join_map",
            f"SELECT l.transform, COUNT(*) AS links, COUNT(p.gtin) AS in_catalogue FROM {U}.recall_product_link l "
            f"LEFT JOIN {U}.product p ON l.gtin = p.gtin GROUP BY l.transform",
            {}, (f"{U}.recall_product_link", f"{U}.product"), (OPS_RAW["recall_product_link"], OFF_RAW),
            "Measured GTIN crosswalk: links per transform and how many match a catalogue product.",
        ),
        _t(
            "dqsql_has_ingredients",
            f"SELECT gtin FROM {U}.product WHERE gtin = '{{gtin}}' AND NOT (ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0)",
            {"gtin": "gtin"}, (f"{U}.product",), (OFF_RAW,), "DQ-equivalent SQL for has_ingredients.",
        ),
        _t(
            "dqsql_english_label",
            f"SELECT gtin FROM {U}.product WHERE gtin = '{{gtin}}' AND NOT (lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0))",
            {"gtin": "gtin"}, (f"{U}.product",), (OFF_RAW,), "DQ-equivalent SQL for english_label.",
        ),
        _t(
            "dqsql_declared_market_code",
            f"SELECT d.gtin, d.market_code FROM {U}.declared_allergen d LEFT JOIN {U}.market_allergen m ON d.market_code = m.market_code "
            f"WHERE d.gtin = '{{gtin}}' AND m.market_code IS NULL",
            {"gtin": "gtin"}, (f"{U}.declared_allergen", f"{U}.market_allergen"), (OFF_RAW, OPS_RAW["market_allergen"]),
            "DQ-equivalent SQL for the market_code foreign key on declared_allergen.",
        ),
        _t(
            "dqsql_extracted_market_code",
            f"SELECT e.gtin, e.market_code FROM {U}.extracted_allergen e LEFT JOIN {U}.market_allergen m ON e.market_code = m.market_code "
            f"WHERE e.gtin = '{{gtin}}' AND m.market_code IS NULL",
            {"gtin": "gtin"}, (f"{U}.extracted_allergen", f"{U}.market_allergen"), (OPS_RAW["extracted_allergen"], OPS_RAW["market_allergen"]),
            "DQ-equivalent SQL for the market_code foreign key on extracted_allergen.",
        ),
        _t("dq_invalid_has_ingredients", f"SHOW DQ INVALID RECORD has_ingredients TABLE {U}.product", {}, (f"{U}.product",), (OFF_RAW,), "DQ invalid records: has_ingredients."),
        _t("dq_invalid_english_label", f"SHOW DQ INVALID RECORD english_label TABLE {U}.product", {}, (f"{U}.product",), (OFF_RAW,), "DQ invalid records: english_label."),
        _t(
            "dq_invalid_declared_market_code", f"SHOW DQ INVALID RECORD market_code TABLE {U}.declared_allergen", {},
            (f"{U}.declared_allergen",), (OFF_RAW, OPS_RAW["market_allergen"]), "DQ invalid records: market_code FK on declared_allergen.",
        ),
        _t(
            "dq_invalid_extracted_market_code", f"SHOW DQ INVALID RECORD market_code TABLE {U}.extracted_allergen", {},
            (f"{U}.extracted_allergen",), (OPS_RAW["extracted_allergen"], OPS_RAW["market_allergen"]), "DQ invalid records: market_code FK on extracted_allergen.",
        ),
        _t("dq_rules", f"LIST DQ USL {U}", {}, (U,), (), "Every key constraint and DQ rule in clearance_usl."),
        _t("usl_model", "LOAD USL clearance_usl NAMESPACE lightning.metastore.clearshelf", {}, (U,), (), "The clearance_usl model as JSON (planner map)."),
    ]
}


def validate_param(kind: str, value: object) -> str:
    if not isinstance(value, str):
        raise BadParams(f"{kind} must be a string")
    pattern = PARAM_PATTERNS[kind]
    if not pattern.match(value):
        raise BadParams(f"invalid {kind}: {value[:40]!r}")
    if kind == "gtin" and not gtin_check_digit_ok(value):
        raise BadParams(f"GTIN check digit fails: {value}")
    return value


def render(template_id: str, params: dict | None) -> tuple[Template, str]:
    """The template and its SQL with validated parameters substituted."""
    t = TEMPLATES.get(template_id)
    if t is None:
        raise BadParams(f"unknown template: {template_id}")
    params = params or {}
    extra = set(params) - set(t.params)
    missing = set(t.params) - set(params)
    if extra or missing:
        raise BadParams(f"template {template_id} takes {sorted(t.params)}; missing {sorted(missing)}, unexpected {sorted(extra)}")
    values = {name: validate_param(kind, params[name]) for name, kind in t.params.items()}
    sql = t.sql
    for name, value in values.items():
        sql = sql.replace("{" + name + "}", value)
    return t, sql
