from pathlib import Path

import pytest

from gateway import allowlist
from gateway.allowlist import Refused, check
from gateway.jdbc import split_statements

SQL_DIR = Path(__file__).resolve().parents[2] / "zetaris" / "sql"
U = "lightning.metastore.clearshelf.clearance_usl"


def rest(url: str, db: str = "CLEARSHELF_OFF") -> str:
    return (f'CREATE LIGHTNING REST TABLE t1 FROM {db} REQUEST( endpoint "{url}", method "get", '
            'response_type "json", http_encoding "URLENCODED" ) HEADER ( user-agent "ClearShelf/0.1" ) BODY ()')


@pytest.mark.parametrize("sql", [
    "SELECT 1",
    f"SELECT gtin FROM {U}.product WHERE gtin = '0816929000119'",
    "SHOW LIGHTNING DATABASES",
    "DESCRIBE clearshelf_off.off_0816929000119",
    "LOAD USL clearance_usl NAMESPACE lightning.metastore.clearshelf",
    f"LIST DQ USL {U}",
    f"RUN DQ has_ingredients TABLE {U}.product",
    f"SHOW DQ INVALID RECORD has_ingredients TABLE {U}.product",
])
def test_reader_reads(sql):
    assert check(sql, "reader") == "read"


@pytest.mark.parametrize("sql", [
    "DROP LIGHTNING DATABASE CLEARSHELF_OFF",
    "drop view x.y",
    "GRANT SELECT ON x TO y",
    "REVOKE USER a FROM ROLE b",
    "INVALIDATE CACHE",
    'OFFSITE CACHE TABLE clearshelf_fda.enforcement_undeclared TO MEMORY WITH (expireInSec "-1")',
    "SELECT 1;",
    "SELECT 1; SELECT 2",
    "SELECT * FROM x WHERE url = 'http://localhost:8889/'",
    "",
])
def test_always_refused(sql):
    for role in allowlist.ROLES:
        with pytest.raises(Refused):
            check(sql, role)


def test_semicolon_inside_literal_is_one_statement():
    assert check("SELECT 'a;b' AS x", "reader") == "read"


def test_reader_cannot_register_or_cache():
    with pytest.raises(Refused):
        check(rest("https://world.openfoodfacts.org/api/v2/product/0816929000119.json"), "reader")
    with pytest.raises(Refused):
        check("CACHE TABLE clearshelf_fda.enforcement_undeclared", "reader")


@pytest.mark.parametrize("url", [
    "https://world.openfoodfacts.org/api/v2/product/0816929000119.json?fields=code",
    "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&limit=1000",
    "https://data.food.gov.uk/food-alerts/id?type=AA&_limit=200",
    "http://clearshelf-ops/decisions.json",
])
def test_registrar_rest_hosts(url):
    assert check(rest(url), "registrar") == "register"


@pytest.mark.parametrize("url", [
    "https://evil.example.com/x.json",
    "http://world.openfoodfacts.org/api/v2/product/1.json",
    "https://clearshelf-ops/decisions.json",
    "http://clearshelf-ops:8080/x.json",
    "http://localhost:8888/api",
])
def test_registrar_rest_hosts_refused(url):
    with pytest.raises(Refused):
        check(rest(url), "registrar")


def test_registrar_rest_database_must_be_clearshelf():
    with pytest.raises(Refused):
        check(rest("https://api.fda.gov/food/enforcement.json", db="NY_TAXI"), "registrar")


def test_registrar_cache_scope():
    assert check("CACHE TABLE clearshelf_fda.enforcement_undeclared", "registrar") == "register"
    assert check("UNCACHE TABLE clearshelf_fsa.allergy_alerts", "registrar") == "register"
    with pytest.raises(Refused):
        check("CACHE TABLE ny_taxi.trips", "registrar")


def test_activate_scope():
    assert check(f"ACTIVATE USL TABLE {U}.product AS SELECT 1 AS gtin", "registrar") == "register"
    with pytest.raises(Refused):
        check("ACTIVATE USL TABLE lightning.metastore.other.usl.t AS SELECT 1", "registrar")


def test_onboarding_only_statements():
    compile_sql = ("COMPILE USL IF NOT EXISTS clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL\n"
                   "CREATE TABLE a (x varchar(2) NOT NULL PRIMARY KEY);\nCREATE TABLE b (y varchar(2))")
    for sql in (compile_sql, f"REGISTER DQ r TABLE {U}.product AS gtin IS NOT NULL",
                'CREATE LIGHTNING DATABASE CLEARSHELF_X DESCRIBE BY "x"',
                "REMOVE USL clearance_usl NAMESPACE lightning.metastore.clearshelf"):
        with pytest.raises(Refused):
            check(sql, "registrar")
        assert check(sql, "onboard") == "onboard"
    with pytest.raises(Refused):
        check("REMOVE USL other NAMESPACE lightning.metastore.clearshelf", "onboard")


@pytest.mark.parametrize("tail", [
    "; DROP TABLE clearshelf_fda.enforcement_undeclared",
    ";\nGRANT ALL ON x TO y",
    "; CREATE TABLE b (y int); INVALIDATE CACHE",
    ";; CREATE TABLE b (y int)",
    "; CREATE TABLE b (y int) ; ",
    "; REMOVE USL clearance_usl NAMESPACE lightning.metastore.clearshelf",
    "; CREATE TABLE b (y int, z int DROP)",
])
def test_compile_refuses_anything_but_create_table_parts(tail):
    for head in ("COMPILE USL clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL CREATE TABLE x (a int)",
                 "COMPILE USL IF NOT EXISTS clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL\nCREATE TABLE x (a int)"):
        with pytest.raises(Refused):
            check(head + tail, "onboard")


def test_compile_scope_and_literal_semicolons():
    ok = ("COMPILE USL clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL "
          "CREATE TABLE x (a varchar(5) DEFAULT 'a;b'); CREATE TABLE y (b int)")
    assert check(ok, "onboard") == "onboard"
    for bad in ("COMPILE USL other DEPLOY NAMESPACE lightning.metastore.clearshelf DDL CREATE TABLE x (a int)",
                "COMPILE USL clearance_usl DEPLOY NAMESPACE lightning.metastore.other DDL CREATE TABLE x (a int)",
                "COMPILE USL clearance_usl DEPLOY NAMESPACE lightning.metastore.clearshelf DDL DROP TABLE x"):
        with pytest.raises(Refused):
            check(bad, "onboard")


def test_every_committed_script_passes_onboard():
    files = sorted(SQL_DIR.glob("*.sql"))
    assert files
    n = 0
    for f in files:
        for stmt in split_statements(f.read_text(encoding="utf-8")):
            check(stmt.replace("YOUR_APP_NAME YOUR_CONTACT_EMAIL", "ClearShelf/0.1"), "onboard")
            n += 1
    assert n > 50
