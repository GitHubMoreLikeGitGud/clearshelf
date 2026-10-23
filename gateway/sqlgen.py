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
