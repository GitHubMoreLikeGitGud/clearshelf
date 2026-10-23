import json
from pathlib import Path

import pytest

from gateway import manifest, sqlgen
from gateway.jdbc import split_statements

SQL_DIR = Path(__file__).resolve().parents[2] / "zetaris" / "sql"
PUFFS_DESCRIBE = [
    ["code", "string", None],
    ["product", "struct<allergens_tags:array<string>,code:string,countries_tags:array<string>,labels_tags:array<string>,"
                "lang:string,last_modified_t:bigint,product_name:string,traces_tags:array<string>>", None],
    ["status", "bigint", None],
]


@pytest.mark.parametrize("gtin,ok", [
    ("0816929000119", True), ("4056489125846", True), ("5000254020408", True), ("0850041392103", True),
    ("0816929000118", False), ("816929000119", False), ("abcdefghijklm", False),
])
def test_check_digit(gtin, ok):
    assert sqlgen.gtin_check_digit_ok(gtin) is ok


def test_struct_fields_nested():
    assert sqlgen.struct_fields("struct<a:string,b:array<struct<c:string,d:bigint>>,e:struct<f:string>>") == {"a", "b", "e"}


def test_product_fields_from_describe():
    fields = sqlgen.product_fields_from_describe(PUFFS_DESCRIBE)
    assert "brands" not in fields and "ingredients_text" not in fields and "labels_tags" in fields


def test_missing_fields_become_typed_nulls():
    sku = sqlgen.Sku("0816929000119", ["UK"], sqlgen.product_fields_from_describe(PUFFS_DESCRIBE))
    sql = sqlgen.product_branch(sku)
    assert "CAST(NULL AS STRING) AS brand" in sql
    assert "CAST(NULL AS STRING) AS ingredients_text" in sql
    assert "product.brands" not in sql


def test_declared_keys_are_coalesced_and_grouped():
    sku = sqlgen.Sku("4056489125846", ["UK", "US"], {"allergens_tags", "traces_tags"})
    sql = sqlgen.activate_declared([sku])
    assert sql.count("UNION ALL") == 3
    assert "COALESCE(concat('4056489125846', '|', 'US', '|', allergen, '|', 'contains'), '') AS declared_key" in sql
    assert "GROUP BY allergen" in sql
    assert "WHEN 'en:gluten' THEN 'gluten_cereal'" in sql


def test_declared_with_no_tag_arrays_is_typed_empty():
    sql = sqlgen.activate_declared([sqlgen.Sku("0816929000119", ["UK"], set())])
    assert "WHERE 1 = 0" in sql


def test_bad_inputs():
    with pytest.raises(ValueError):
        sqlgen.Sku("0816929000118", ["UK"])
    with pytest.raises(ValueError):
        sqlgen.Sku("0816929000119", ["EU"])


def _committed_skus():
    """Catalogue SKUs (role demo, manifest order) with the DESCRIBE fields recorded at onboarding."""
    described = json.loads((SQL_DIR.parent / "off_describe.json").read_text(encoding="utf-8"))
    skus = manifest.select(manifest.load(SQL_DIR.parents[1] / "data" / "manifest" / "skus.json"), manifest.CATALOGUE_ROLES)
    return skus, [sqlgen.Sku(m.gtin, list(m.markets), set(described[m.gtin])) for m in skus if m.gtin in described]


def test_every_catalogue_sku_was_described_at_onboarding():
    skus, described = _committed_skus()
    assert [s.gtin for s in described] == [m.gtin for m in skus]


def test_committed_off_script_matches_generator():
    sql = sqlgen.create_off_table("0816929000119")
    assert 'endpoint "https://world.openfoodfacts.org/api/v2/product/0816929000119.json?fields=code,product_name' in sql
    committed = [" ".join(s.split()) for s in split_statements((SQL_DIR / "04_off_products_create.sql").read_text(encoding="utf-8"))]
    skus, _ = _committed_skus()
    for m in skus:
        assert " ".join(sqlgen.create_off_table(m.gtin).split()) in committed
        assert f"CACHE TABLE clearshelf_off.off_{m.gtin}" in committed
    assert len(committed) == 3 * len(skus)


def test_committed_activation_matches_generator():
    _, described = _committed_skus()
    text = (SQL_DIR / "11_clearance_usl_activate_create.sql").read_text(encoding="utf-8")
    assert text == sqlgen.activation_script(described)
    committed = [" ".join(s.split()) for s in split_statements(text)]
    assert " ".join(sqlgen.activate_product(described).split()) in committed
    assert " ".join(sqlgen.activate_declared(described).split()) in committed
