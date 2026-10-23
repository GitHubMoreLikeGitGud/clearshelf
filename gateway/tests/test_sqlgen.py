from pathlib import Path

import pytest

from gateway import sqlgen
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


def test_create_off_table_matches_committed_script():
    sql = sqlgen.create_off_table("5000254020408")
    assert 'endpoint "https://world.openfoodfacts.org/api/v2/product/5000254020408.json?fields=code,product_name' in sql
    committed = split_statements((SQL_DIR / "04_off_products_create.sql").read_text(encoding="utf-8"))
    assert " ".join(sql.split()) in [" ".join(s.split()) for s in committed]


def test_committed_activation_matches_generator():
    fields = {
        "0816929000119": sqlgen.product_fields_from_describe(PUFFS_DESCRIBE),
        "4056489125846": {"allergens_tags", "brands", "code", "countries_tags", "ingredients_text", "labels_tags", "lang",
                          "last_modified_t", "product_name", "traces_tags"},
        "5000254020408": {"allergens_tags", "brands", "code", "countries_tags", "ingredients_text", "ingredients_text_en",
                          "labels_tags", "lang", "last_modified_t", "product_name", "traces_tags"},
    }
    skus = [sqlgen.Sku("0816929000119", ["UK", "US"], fields["0816929000119"]),
            sqlgen.Sku("4056489125846", ["UK", "US"], fields["4056489125846"]),
            sqlgen.Sku("5000254020408", ["UK"], fields["5000254020408"])]
    text = (SQL_DIR / "11_clearance_usl_activate_create.sql").read_text(encoding="utf-8")
    committed = [" ".join(s.split()) for s in split_statements(text)]
    assert " ".join(sqlgen.activate_product(skus).split()) in committed
    assert " ".join(sqlgen.activate_declared(skus).split()) in committed
