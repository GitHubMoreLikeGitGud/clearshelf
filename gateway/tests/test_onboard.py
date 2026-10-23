import json
import shutil
from pathlib import Path

import pytest

from gateway import manifest, onboard, sqlgen
from gateway.jdbc import QueryResult, ZetarisError, split_statements

REPO = Path(__file__).resolve().parents[2]
FULL = ["allergens_tags", "brands", "code", "countries_tags", "ingredients_text", "ingredients_text_en", "labels_tags",
        "lang", "last_modified_t", "product_name", "traces_tags"]
NO_BRANDS = [f for f in FULL if f not in ("brands", "ingredients_text", "ingredients_text_en")]


def struct(fields):
    types = {"allergens_tags": "array<string>", "traces_tags": "array<string>", "labels_tags": "array<string>",
             "countries_tags": "array<string>", "last_modified_t": "bigint"}
    return "struct<" + ",".join(f"{f}:{types.get(f, 'string')}" for f in sorted(fields)) + ">"


class FakeZetaris:
    """Answers the onboarding statements from an in-memory model of the instance."""

    def __init__(self, off_tables=(), fields=None, usl=True, fail_create=0):
        self.off_tables = {t.lower() for t in off_tables}
        self.fields = fields or {}
        self.usl = usl
        self.fail_create = fail_create
        self.sql: list[str] = []

    def result(self, sql, columns=(), rows=()):
        return QueryResult(sql=sql, columns=list(columns), rows=[list(r) for r in rows], row_count=len(rows),
                           elapsed_ms=3, executed_at="2026-10-24T09:00:00+0800")

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        s = " ".join(sql.split())
        if s == "SHOW LIGHTNING DATABASES":
            return self.result(sql, ["name"], [[d] for d in ("CLEARSHELF_FDA", "CLEARSHELF_FSA", "CLEARSHELF_OFF", "CLEARSHELF_OPS")])
        if s.startswith("SHOW TABLES IN clearshelf_off"):
            return self.result(sql, ["table_identifier"], [[f"CLEARSHELF_OFF.{t}"] for t in sorted(self.off_tables)])
        if s.startswith("SHOW TABLES IN clearshelf_fda"):
            return self.result(sql, ["table_identifier"], [["CLEARSHELF_FDA.enforcement_undeclared"]])
        if s.startswith("SHOW TABLES IN clearshelf_fsa"):
            return self.result(sql, ["table_identifier"], [["CLEARSHELF_FSA.allergy_alerts"]])
        if s.startswith("SHOW TABLES IN clearshelf_ops"):
            return self.result(sql, ["table_identifier"], [[f"CLEARSHELF_OPS.{t}"] for t in onboard.OPS_TABLES])
        if s == "SHOW NAMESPACES OR TABLES IN lightning.metastore":
            return self.result(sql, ["name"], [["clearshelf"]])
        if s == "SHOW NAMESPACES OR TABLES IN lightning.metastore.clearshelf":
            return self.result(sql, ["name"], [["clearance_usl"]] if self.usl else [])
        if s.startswith("LIST DQ USL"):
            return self.result(sql, ["name", "table"], [["has_ingredients", "product"], ["english_label", "product"],
                                                        ["known_relation", "extracted_allergen"]])
        if s.startswith("CREATE LIGHTNING REST TABLE off_"):
            if self.fail_create:
                self.fail_create -= 1
                raise ZetarisError("HTTP 429 Too Many Requests")
            self.off_tables.add(s.split()[4].lower())
            return self.result(sql)
        if s.startswith("DESCRIBE clearshelf_off.off_"):
            g = s.split("off_")[-1]
            return self.result(sql, ["col_name", "data_type", "comment"],
                               [["code", "string", None], ["product", struct(self.fields.get(g, FULL)), None]])
        if s.startswith("RUN DQ"):
            return self.result(sql, ["name", "table", "type", "total_record", "valid_record", "invalid_record"],
                               [[s.split()[2], "t", "x", 3, 2, 1]])
        if s.startswith("SHOW DQ INVALID RECORD"):
            return self.result(sql, ["gtin", "ingredients_text"], [["0816929000119", "secret label text"]])
        if s.startswith("SELECT '") and "AS usl_table" in s:
            return self.result(sql, ["usl_table", "n"], [[t, 1] for t in sqlgen.ACTIVATION_ORDER])
        return self.result(sql)


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps: list[float] = []

    def time(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


MANIFEST_SKUS = [
    {"gtin": "0816929000119", "role": "demo", "markets": ["UK"], "display_name": "Puffs",
     "recalls": [{"recall_number": "H-1328-2026", "upc_as_published": "816929000119", "transform": "upc12_pad13"}]},
    {"gtin": "0072992042603", "role": "demo", "markets": ["UK", "US"], "display_name": "Macadamia",
     "recalls": [{"recall_number": "F-0636-2025", "upc_as_published": "0 72992 04260 3", "transform": "upc12_pad13"}]},
    {"gtin": "0041383090738", "role": "eval_only", "markets": ["UK"], "display_name": "Lactose free milk",
     "recalls": [{"recall_number": "F-0054-2025", "upc_as_published": "0 41383 09073 8", "transform": "upc12_pad13"}]},
]


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A scratch copy of the paths onboarding reads and writes."""
    (tmp_path / "data" / "manifest").mkdir(parents=True)
    (tmp_path / "data" / "manifest" / "skus.json").write_text(json.dumps({"skus": MANIFEST_SKUS}), encoding="utf-8")
    ops = tmp_path / "data" / "ops"
    ops.mkdir(parents=True)
    links = {"data": [dict(onboard.SENTINELS["recall_links"]),
                      {"link_key": "H-1328-2026|0816929000119", "recall_number": "H-1328-2026", "gtin": "0816929000119",
                       "raw_code": "816929000119", "transform": "upc12_pad13", "extracted_by": "gate-seed"},
                      {"link_key": "H-0011-2027|0850041392103", "recall_number": "H-0011-2027", "gtin": "0850041392103",
                       "raw_code": "850041392103", "transform": "upc12_pad13", "extracted_by": "notice-extract"}]}
    (ops / "recall_links.json").write_text(json.dumps(links), encoding="utf-8")
    for name in ("health", "market_allergens", "decisions", "extractions"):
        (ops / f"{name}.json").write_text(json.dumps({"data": [onboard.SENTINELS[name]]}), encoding="utf-8")
    sql_dir = tmp_path / "zetaris" / "sql"
    shutil.copytree(REPO / "zetaris" / "sql", sql_dir)
    readme = tmp_path / "zetaris" / "README.md"
    readme.write_text(f"# x\n\n{onboard.README_START}\nold\n{onboard.README_END}\n\ntail\n", encoding="utf-8")
    monkeypatch.setattr(onboard, "ROOT", tmp_path)
    monkeypatch.setattr(onboard, "MANIFEST", tmp_path / "data" / "manifest" / "skus.json")
    monkeypatch.setattr(onboard, "OPS_DIR", ops)
    monkeypatch.setattr(onboard, "EVIDENCE_DIR", tmp_path / "data" / "evidence")
    monkeypatch.setattr(onboard, "SQL_DIR", sql_dir)
    monkeypatch.setattr(onboard, "DESCRIBE_FILE", tmp_path / "zetaris" / "off_describe.json")
    monkeypatch.setattr(onboard, "README", readme)
    monkeypatch.setattr(onboard, "ops_served_count", lambda name: None)
    monkeypatch.setenv("CLEARSHELF_USER_AGENT", "ClearShelf/0.1")
    return tmp_path


def make(conn, storage_cached, **kw):
    clock = Clock()
    storage = {"app_id": "local-1", "cached": set(storage_cached)}
    out: list[dict] = []
    args = onboard.Args(**kw)
    ob = onboard.Onboarder(conn, args, storage=lambda: storage, sleep=clock.sleep, clock=clock.time, out=out.append)
    return ob, clock, storage, out


def sent(conn):
    """Statements other than the read-only existence checks."""
    return [s for s in conn.sql if not s.startswith(("SHOW LIGHTNING", "SHOW TABLES", "SHOW NAMESPACES", "LIST DQ"))]


FEEDS_CACHED = {"clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts"}


def test_dry_run_sends_only_existence_checks(repo):
    conn = FakeZetaris(off_tables=["off_0816929000119"])
    ob, _, _, out = make(conn, FEEDS_CACHED | {"clearshelf_off.off_0816929000119"}, dry_run=True, skip_exists=True)
    assert ob.execute() == 0
    assert sent(conn) == []
    plans = [o["plan"] for o in out if "plan" in o]
    assert any(p.startswith("CREATE LIGHTNING REST TABLE off_0072992042603") for p in plans)
    assert not any(p.startswith("CREATE LIGHTNING REST TABLE off_0816929000119") for p in plans)
    assert any("ACTIVATE USL TABLE lightning.metastore.clearshelf.clearance_usl.product" in p for p in plans)
    assert not (repo / "zetaris" / "off_describe.json").exists()


def test_existing_objects_stop_the_run_without_skip_exists(repo):
    conn = FakeZetaris(off_tables=["off_0816929000119"])
    ob, _, _, out = make(conn, FEEDS_CACHED, phases=("off",))
    assert ob.execute() == 2
    assert sent(conn) == []
    assert out[-1]["already_exist"] == ["clearshelf_off.off_0816929000119"]


def test_off_phase_registers_describes_caches_with_spacing(repo):
    conn = FakeZetaris(off_tables=["off_0816929000119"], fields={"0072992042603": NO_BRANDS})
    # Eval-only SKUs are registered only when asked for (the eval runner's path).
    ob, clock, storage, _ = make(conn, FEEDS_CACHED | {"clearshelf_off.off_0816929000119"}, skip_exists=True,
                                 phases=("off",), off_gap_s=5.0, roles=manifest.ROLES)
    real_execute = conn.execute

    def execute(sql, timeout_s=None, max_rows=None):
        res = real_execute(sql, timeout_s, max_rows)
        if sql.startswith("CACHE TABLE"):
            storage["cached"].add(sql.split()[-1])
        return res

    conn.execute = execute
    assert ob.execute() == 0
    stmts = sent(conn)
    kinds = [" ".join(s.split()[:2]) for s in stmts]
    assert kinds == ["DESCRIBE clearshelf_off.off_0816929000119", "CREATE LIGHTNING", "DESCRIBE clearshelf_off.off_0072992042603",
                     "CACHE TABLE", "CREATE LIGHTNING", "DESCRIBE clearshelf_off.off_0041383090738", "CACHE TABLE"]
    assert all('user-agent "ClearShelf/0.1"' in s for s in stmts if s.startswith("CREATE"))
    # 4 OFF calls; the 3 after the first each waited the full gap (the fake clock does not advance otherwise)
    assert clock.sleeps == [5.0, 5.0, 5.0]
    assert ob.fields["0072992042603"] == set(NO_BRANDS)


def test_off_call_is_retried_then_succeeds(repo):
    conn = FakeZetaris(fail_create=1)
    ob, clock, _, out = make(conn, FEEDS_CACHED, skip_exists=True, phases=("off",), gtins=("0072992042603",))
    ob.execute()
    creates = [s for s in conn.sql if s.startswith("CREATE")]
    assert len(creates) == 2
    assert any(o.get("ok") is False and "429" in o.get("error", "") for o in out)
    assert min(clock.sleeps) >= onboard.OFF_GAP_FLOOR_S


def test_off_gap_never_below_floor(repo):
    ob, *_ = make(FakeZetaris(), FEEDS_CACHED, off_gap_s=0.5)
    assert ob.gap() == onboard.OFF_GAP_FLOOR_S


def test_activation_uses_typed_nulls_and_leaves_out_uncached_tables(repo):
    conn = FakeZetaris(off_tables=["off_0816929000119", "off_0072992042603", "off_0041383090738"],
                       fields={"0816929000119": NO_BRANDS})
    cached = FEEDS_CACHED | {"clearshelf_off.off_0816929000119", "clearshelf_off.off_0072992042603"}
    ob, *_ = make(conn, cached, skip_exists=True, phases=("links", "activate"), write_files=False, roles=manifest.ROLES)
    assert ob.execute() == 1  # one SKU left out is an error to report
    product = next(s for s in conn.sql if s.startswith(f"ACTIVATE USL TABLE {sqlgen.USL}.product"))
    assert "'0816929000119' AS gtin" in product and "CAST(NULL AS STRING) AS brand" in product
    assert "'0072992042603' AS gtin" in product and "off_0041383090738" not in product
    assert any("0041383090738: OFF table not cached" in e for e in ob.summary["errors"])
    activated = [s.split()[3].split(".")[-1] for s in conn.sql if s.startswith("ACTIVATE")]
    assert activated == ["product", "declared_allergen", "recall_product_link"]


def test_links_phase_writes_f_prefixed_links_and_keeps_other_writers(repo):
    conn = FakeZetaris()
    ob, *_ = make(conn, FEEDS_CACHED, skip_exists=True, phases=("links",))
    ob.execute()
    rows = json.loads((repo / "data" / "ops" / "recall_links.json").read_text(encoding="utf-8"))["data"]
    assert rows[0]["link_key"] == "__schema__"
    by_key = {r["link_key"]: r for r in rows[1:]}
    # The eval-only SKU's link (F-0054-2025) stays out: by default only the demo catalogue is onboarded.
    assert set(by_key) == {"H-0011-2027|0850041392103", "H-1328-2026|0816929000119", "F-0636-2025|0072992042603"}
    assert by_key["H-1328-2026|0816929000119"]["extracted_by"] == "manifest"  # gate seed replaced
    assert by_key["H-0011-2027|0850041392103"]["extracted_by"] == "notice-extract"  # agent row kept
    assert all(isinstance(v, str) for r in rows for v in r.values())
    assert ob.summary["links"]["f_prefixed"] == 1 and ob.summary["links"]["replaced_seed_rows"] == 1


def test_default_roles_are_the_demo_catalogue():
    assert onboard.Args().roles == manifest.CATALOGUE_ROLES == ("demo",)
    assert onboard.parse_args([]).roles == ("demo",)
    assert onboard.parse_args(["--roles", "demo,eval_only"]).roles == ("demo", "eval_only")


def test_recall_links_reject_other_prefixes():
    sku = manifest.ManifestSku("0816929000119", "demo", ("UK",), "x", ({"recall_number": "Z-0001-2026"},))
    with pytest.raises(manifest.ManifestError):
        manifest.recall_links([sku])
    ok = manifest.ManifestSku("0816929000119", "demo", ("UK",), "x", ({"recall_number": "F-0001-2026", "upc_as_published": "1"},))
    assert manifest.recall_links([ok])[0]["recall_number"] == "F-0001-2026"


def test_dq_keeps_only_key_columns_of_invalid_records(repo, temp_sql_log):
    conn = FakeZetaris()
    ob, *_ = make(conn, FEEDS_CACHED, skip_exists=True, phases=("dq",))
    ob.execute()
    inv = ob.summary["dq"]["invalid"]["has_ingredients@product"]
    assert inv["columns"] == ["gtin"] and inv["rows"] == [["0816929000119"]]
    assert "secret label text" not in temp_sql_log.read_text(encoding="utf-8")
    assert not any(s.startswith("REGISTER DQ") for s in conn.sql)  # all three custom rules exist
    assert ob.summary["dq"]["run"]["has_ingredients@product"]["invalid_record"] == 1


def test_full_run_writes_scripts_describe_file_and_readme(repo):
    conn = FakeZetaris(off_tables=["off_0816929000119", "off_0072992042603", "off_0041383090738"],
                       fields={"0816929000119": NO_BRANDS})
    cached = FEEDS_CACHED | {f"clearshelf_off.off_{s['gtin']}" for s in MANIFEST_SKUS}
    ob, *_ = make(conn, cached, skip_exists=True)
    assert ob.execute() == 0, ob.summary["errors"]
    assert sent(conn)[:2] == ["DESCRIBE clearshelf_off.off_0816929000119", "DESCRIBE clearshelf_off.off_0072992042603"]
    assert not any(s.startswith(("CREATE", "CACHE", "COMPILE")) for s in conn.sql)
    recorded = json.loads((repo / "zetaris" / "off_describe.json").read_text(encoding="utf-8"))
    assert recorded["0816929000119"] == sorted(NO_BRANDS)
    # The eval-only SKU is registered and cached here, but stays out of the demo catalogue.
    assert "0041383090738" not in recorded
    skus = [sqlgen.Sku(s["gtin"], s["markets"], set(recorded[s["gtin"]])) for s in MANIFEST_SKUS if s["role"] == "demo"]
    committed = (repo / "zetaris" / "sql" / "11_clearance_usl_activate_create.sql").read_text(encoding="utf-8")
    assert committed == sqlgen.activation_script(skus) and "0041383090738" not in committed
    assert len(split_statements(committed)) == 9
    off_script = (repo / "zetaris" / "sql" / "04_off_products_create.sql").read_text(encoding="utf-8")
    assert len(split_statements(off_script)) == 6 and "F-0636-2025" in off_script and "0041383090738" not in off_script
    readme = (repo / "zetaris" / "README.md").read_text(encoding="utf-8")
    assert readme.startswith("# x") and readme.rstrip().endswith("tail") and "old" not in readme
    assert "| `product` | 1 |" in readme and "| `has_ingredients` | `product` | 3 | 2 | 1 |" in readme
    assert list((repo / "data" / "evidence").glob("onboard-*.json"))


def test_generated_scripts_pass_the_onboard_allowlist(repo):
    from gateway import allowlist
    skus = [sqlgen.Sku(s["gtin"], s["markets"], set(FULL)) for s in MANIFEST_SKUS]
    for text in (sqlgen.activation_script(skus), sqlgen.off_create_script([(s.gtin, "n") for s in skus]),
                 sqlgen.off_select_script([s.gtin for s in skus])):
        for stmt in split_statements(text):
            allowlist.check(stmt.replace(sqlgen.UA_PLACEHOLDER, "ClearShelf/0.1"), "onboard")
