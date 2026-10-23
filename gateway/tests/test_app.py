import json

import pytest
from fastapi.testclient import TestClient

from gateway import app as app_module
from gateway import manifest as manifest_mod
from gateway.app import Gateway, TemplateRequest, create_app
from gateway.jdbc import QueryResult, QueryTimeout, ZetarisError

STORAGE = {"app_id": "local-1", "started_at_ms": 0,
           "cached": {"clearshelf_fda.enforcement_undeclared", "clearshelf_off.off_0816929000119"}}
CONTRACT_KEYS = {"columns", "rows", "row_count", "elapsed_ms", "sql", "sql_sha256", "objects", "executed_at", "cache_state", "error"}
JOIN_MAP = TemplateRequest(template_id="join_map")  # reads recall_product_link and the product union


@pytest.fixture(autouse=True)
def catalogue_manifest(tmp_path, monkeypatch):
    """Tests never read the repository manifest: by default the catalogue is the
    one demo SKU whose OFF table STORAGE holds."""
    root = tmp_path / "default_root"
    (root / "data" / "manifest").mkdir(parents=True)
    (root / "data" / "manifest" / "skus.json").write_text(
        json.dumps({"skus": [{"gtin": "0816929000119", "role": "demo"}]}), encoding="utf-8")
    monkeypatch.setattr(app_module, "ROOT", root)


class FakeConn:
    def __init__(self, rows=None, fail=None):
        self.rows = rows if rows is not None else [[1]]
        self.fail = fail
        self.sql = []
        self.closed = 0

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        if self.fail and sql != "SELECT 1":
            raise self.fail
        return QueryResult(sql=sql, columns=["c"], rows=self.rows, row_count=len(self.rows), elapsed_ms=5,
                           executed_at="2026-10-23T08:00:00+0800")

    def close(self):
        self.closed += 1


def client(conn, storage=STORAGE):
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.start_warmup = lambda: None  # no background warm-up sending statements mid-test
    return TestClient(create_app(gw, warm_on_start=False)), gw


def test_health_ok():
    c, _ = client(FakeConn())
    r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["zetaris"]["select1"] == 1
    assert "clearshelf_fda.enforcement_undeclared" in body["cache"]["cached_tables"]


def test_health_down():
    class Down(FakeConn):
        def execute(self, sql, timeout_s=None, max_rows=None):
            raise ZetarisError("connect failed")

    c, _ = client(Down(), storage=None)
    r = c.get("/health")
    assert r.status_code == 503 and r.json()["ok"] is False


def test_template_contract_and_log(temp_sql_log):
    conn = FakeConn(rows=[[str(i)] for i in range(250)])
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "product", "params": {"gtin": "0816929000119"}})
    assert r.status_code == 200
    body = r.json()
    assert CONTRACT_KEYS <= set(body)
    assert len(body["rows"]) == 200 and body["row_count"] == 250 and body["truncated"] is True
    assert body["cache_state"] == "hit"
    assert body["objects"] == ["lightning.metastore.clearshelf.clearance_usl.product"]
    assert conn.sql[-1].endswith("WHERE gtin = '0816929000119'")
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert logged[-1]["template_id"] == "product" and logged[-1]["sql_sha256"] == body["sql_sha256"]


def test_template_bad_params_never_reach_zetaris():
    conn = FakeConn()
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "product", "params": {"gtin": "0816929000119' OR 1=1 --"}})
    assert r.status_code == 400 and conn.sql == []
    r = c.post("/sql/template", json={"template_id": "product", "params": {"gtin": "0816929000119"}, "role": "onboard"})
    assert r.status_code == 400 and conn.sql == []


def test_template_zetaris_error_is_502():
    conn = FakeConn(fail=ZetarisError("FIELD_NOT_FOUND"))
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "fda_notice", "params": {"recall_number": "H-1328-2026"}})
    assert r.status_code == 502 and "FIELD_NOT_FOUND" in r.json()["error"]


def test_template_timeout_is_504():
    conn = FakeConn(fail=QueryTimeout("no result within 60 s"))
    c, _ = client(conn)
    r = c.post("/sql/template", json={"template_id": "dq_invalid_has_ingredients"})
    assert r.status_code == 504


def test_reconnects_once_when_connection_is_dead():
    class Flaky(FakeConn):
        def __init__(self):
            super().__init__()
            self.dead = True

        def execute(self, sql, timeout_s=None, max_rows=None):
            if self.dead:
                raise ZetarisError("connection reset")
            return super().execute(sql, timeout_s, max_rows)

        def close(self):
            self.dead = False

    conn = Flaky()
    gw = Gateway(connect=lambda role: conn, storage=lambda: None)
    assert gw._execute("reader", "SELECT 1", timeout_s=5).rows == [[1]]


def test_query_error_on_live_connection_is_not_retried():
    conn = FakeConn(fail=ZetarisError("syntax error"))
    gw = Gateway(connect=lambda role: conn, storage=lambda: None)
    with pytest.raises(ZetarisError):
        gw._execute("reader", "SELECT nope", timeout_s=5)
    assert conn.closed == 0


def test_warmup_caches_only_missing(monkeypatch):
    conn = FakeConn(rows=[])
    monkeypatch.setattr(app_module, "cache_targets",
                        lambda: ["clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts"])
    gw = Gateway(connect=lambda role: conn, storage=lambda: STORAGE)
    result = gw.warmup()
    assert result["cached_now"] == ["clearshelf_fsa.allergy_alerts"]
    assert conn.sql == ["CACHE TABLE clearshelf_fsa.allergy_alerts"]


SHOW_OFF_ROWS = [["CLEARSHELF_OFF.off_0816929000119", "CLEARSHELF_OFF", "Lightning Database"],
                 ["CLEARSHELF_OFF.off_5000254020408", "CLEARSHELF_OFF", "Lightning Database"]]


class ShowTablesConn(FakeConn):
    """SHOW TABLES IN clearshelf_off lists two registered OFF tables; CACHE succeeds
    (and, given a storage dict, the table then shows as cached, as in the Spark UI).
    A table in `fail` answers CACHE with an error that many times."""

    def __init__(self, show_fails=False, storage=None, fail=None):
        super().__init__(rows=[])
        self.show_fails = show_fails
        self.storage = storage
        self.fail_cache = dict(fail or {})

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        if sql.startswith("SHOW TABLES"):
            if self.show_fails:
                raise ZetarisError("connection reset")
            return QueryResult(sql=sql, columns=["table_identifier", "catalog_name", "catalog_type"], rows=SHOW_OFF_ROWS,
                               row_count=len(SHOW_OFF_ROWS), elapsed_ms=40, executed_at="2026-10-23T08:00:00+0800")
        if sql.startswith("CACHE TABLE "):
            table = sql.split()[-1]
            if self.fail_cache.get(table, 0) > 0:
                self.fail_cache[table] -= 1
                raise ZetarisError("HTTP 503 Service Unavailable from world.openfoodfacts.org")
            if self.storage is not None:
                self.storage["cached"].add(table.lower())
        return QueryResult(sql=sql, rows=[], elapsed_ms=5, executed_at="2026-10-23T08:00:00+0800")


def fresh(storage):
    return {**storage, "cached": set(storage["cached"])}


@pytest.fixture
def manifest_with_unregistered_gtin(tmp_path, monkeypatch):
    """Manifest: one cached OFF table, one registered but not cached, one with no table yet."""
    m = tmp_path / "data" / "manifest" / "skus.json"
    m.parent.mkdir(parents=True)
    m.write_text(json.dumps({"skus": [{"gtin": "0816929000119"}, {"gtin": "5000254020408"}, {"gtin": "4056489125839"}]}),
                 encoding="utf-8")
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "OFF_SPACING_S", 0)
    return {"app_id": "local-1", "started_at_ms": 0,
            "cached": {"clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts", "clearshelf_off.off_0816929000119"}}


def test_warmup_skips_manifest_gtins_without_a_table(manifest_with_unregistered_gtin, temp_sql_log):
    conn = ShowTablesConn()
    gw = Gateway(connect=lambda role: conn, storage=lambda: manifest_with_unregistered_gtin)
    result = gw.warmup()
    assert conn.sql == ["SHOW TABLES IN clearshelf_off", "CACHE TABLE clearshelf_off.off_5000254020408"]
    assert result["cached_now"] == ["clearshelf_off.off_5000254020408"] and result["failed"] == {}
    assert result["not_registered"] == ["clearshelf_off.off_4056489125839"] and result["already_cached"] == 3
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert [r["sql"] for r in logged] == conn.sql and all(r["error"] is None and "timeout_s" in r for r in logged)


def test_warmup_falls_back_to_cache_log_when_show_tables_fails(manifest_with_unregistered_gtin, temp_sql_log):
    temp_sql_log.write_text(json.dumps({"sql": "CACHE TABLE clearshelf_off.off_5000254020408",
                                        "executed_at": "2026-10-23T07:45:32+0800", "error": None}) + "\n", encoding="utf-8")
    conn = ShowTablesConn(show_fails=True)
    gw = Gateway(connect=lambda role: conn, storage=lambda: manifest_with_unregistered_gtin)
    result = gw.warmup()
    # SELECT 1 is the liveness check after the failed SHOW; the connection answers, so no reconnect.
    assert conn.sql == ["SHOW TABLES IN clearshelf_off", "SELECT 1", "CACHE TABLE clearshelf_off.off_5000254020408"]
    assert result["not_registered"] == ["clearshelf_off.off_4056489125839"]


def test_warmup_skips_show_tables_when_no_off_table_is_missing(manifest_with_unregistered_gtin):
    storage = dict(manifest_with_unregistered_gtin)
    storage["cached"] = storage["cached"] | {"clearshelf_off.off_5000254020408", "clearshelf_off.off_4056489125839"}
    conn = ShowTablesConn()
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    assert gw.warmup()["cached_now"] == [] and conn.sql == []


def test_cache_targets_skip_eval_only_skus(tmp_path, monkeypatch, temp_sql_log):
    """Eval-only SKUs never enter the demo catalogue, so the warm-up does not keep
    them cached; an OFF table cached before but outside the manifest is not a target."""
    m = tmp_path / "data" / "manifest" / "skus.json"
    m.parent.mkdir(parents=True)
    m.write_text(json.dumps({"skus": [{"gtin": "0816929000119", "role": "demo"},
                                      {"gtin": "0041383090738", "role": "eval_only"},
                                      {"gtin": "4056489125839"}]}), encoding="utf-8")
    temp_sql_log.write_text(json.dumps({"sql": "CACHE TABLE clearshelf_off.off_5000254020408",
                                        "executed_at": "2026-10-23T07:45:32+0800", "error": None}) + "\n", encoding="utf-8")
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    assert app_module.cache_targets() == [
        "clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts", "clearshelf_off.off_0816929000119",
        "clearshelf_off.off_4056489125839"]


def test_cache_targets_without_a_readable_manifest_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    with pytest.raises(manifest_mod.ManifestError):
        app_module.cache_targets()
    m = tmp_path / "data" / "manifest" / "skus.json"
    m.parent.mkdir(parents=True)
    m.write_text("{not json", encoding="utf-8")
    with pytest.raises(manifest_mod.ManifestError):
        app_module.cache_targets()


def test_warmup_runs_once_per_driver_app(manifest_with_unregistered_gtin):
    storage = fresh(manifest_with_unregistered_gtin)
    conn = ShowTablesConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    first = gw.warmup()
    assert first["cached_now"] == ["clearshelf_off.off_5000254020408"] and gw.last_app_id == "local-1"
    sent = list(conn.sql)
    assert gw.warmup()["skipped"].startswith("already warmed") and conn.sql == sent
    assert gw.last_warmup == first  # a skipped call does not replace the last result
    gw.warmup(force=True)  # nothing left to cache; the unregistered GTIN is already known
    assert conn.sql == sent
    storage.update(app_id="local-2", cached=set())  # driver restart drops every cache
    gw.warmup()
    assert conn.sql[len(sent):] == ["SHOW TABLES IN clearshelf_off", "CACHE TABLE clearshelf_fda.enforcement_undeclared",
                                    "CACHE TABLE clearshelf_fsa.allergy_alerts", "CACHE TABLE clearshelf_off.off_0816929000119",
                                    "CACHE TABLE clearshelf_off.off_5000254020408"]
    assert gw.last_app_id == "local-2"


def test_reconnect_does_not_rewarm_the_same_driver(manifest_with_unregistered_gtin):
    storage = fresh(manifest_with_unregistered_gtin)
    conn = ShowTablesConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.warmup()
    n = len(conn.sql)
    gw.warmup()  # what start_warmup() runs after a reconnect
    assert conn.sql[n:] == []


def test_failed_cache_is_retried_with_backoff_not_dropped(manifest_with_unregistered_gtin, temp_sql_log):
    """A failed CACHE (HTTP 503 from Open Food Facts) keeps the app not warmed; the
    next tries wait RETRY_BASE_S, then twice that, and the app is warmed once it succeeds."""
    storage = fresh(manifest_with_unregistered_gtin)
    bad = "clearshelf_off.off_5000254020408"
    conn = ShowTablesConn(storage=storage, fail={bad: 2})
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    clock = [1000.0]
    gw._clock = lambda: clock[0]
    first = gw.warmup()
    assert bad in first["failed"] and gw.last_app_id is None
    n = len(conn.sql)
    second = gw.warmup()  # same driver, inside the backoff: nothing is sent
    assert second["retry_in_s"] == {bad: app_module.RETRY_BASE_S} and conn.sql[n:] == []
    clock[0] += app_module.RETRY_BASE_S
    third = gw.warmup()
    assert bad in third["failed"] and conn.sql[n:].count(f"CACHE TABLE {bad}") == 1
    assert gw.warmup()["retry_in_s"] == {bad: 2 * app_module.RETRY_BASE_S}
    clock[0] += 2 * app_module.RETRY_BASE_S
    fourth = gw.warmup()
    assert fourth["cached_now"] == [bad] and fourth["failed"] == {} and gw.last_app_id == "local-1"
    assert gw.warmup()["skipped"].startswith("already warmed")


def test_off_templates_wait_for_the_warmup(manifest_with_unregistered_gtin, temp_sql_log):
    """While a registered catalogue OFF table is uncached, a template that reads the
    product union gets 503 and starts a warm-up; nothing reaches Zetaris."""
    storage = fresh(manifest_with_unregistered_gtin)
    conn = ShowTablesConn(storage=storage)
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    started = []
    gw.start_warmup = lambda: started.append(1)
    status, body = gw.run_template(JOIN_MAP)
    assert status == 503 and body["error"].startswith("warming: ") and started and conn.sql == []
    assert body["cache_state"] == "miss" and body["cache_detail"]["clearshelf_off.off_5000254020408"] == "miss"
    logged = [json.loads(line) for line in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert logged[-1]["template_id"] == "join_map" and logged[-1]["sent"] is False
    status, _ = gw.run_template(TemplateRequest(template_id="fda_notice", params={"recall_number": "F-0636-2025"}))
    assert status == 200  # reads no OFF table
    gw.warmup()  # caches 5000254020408 and learns that 4056489125839 has no table yet
    started.clear()
    status, body = gw.run_template(JOIN_MAP)
    assert status == 200 and body["cache_state"] == "hit" and not started


def test_a_request_warms_a_driver_the_start_could_not_see(manifest_with_unregistered_gtin):
    """Spark UI down at start: the start-up warm-up skips; the first request on a
    reachable driver starts one and holds the OFF read."""
    state = {"storage": None}
    conn = ShowTablesConn()
    gw = Gateway(connect=lambda role: conn, storage=lambda: state["storage"])
    assert gw.warmup()["skipped"] == "spark ui unreachable" and gw.last_app_id is None
    state["storage"] = {"app_id": "local-new", "started_at_ms": 0, "cached": set()}
    started = []
    gw.start_warmup = lambda: started.append(1)
    status, body = gw.run_template(JOIN_MAP)
    assert status == 503 and started and conn.sql == []


def test_unreadable_manifest_is_reported_and_holds_off_templates(tmp_path, monkeypatch, temp_sql_log):
    m = tmp_path / "data" / "manifest" / "skus.json"
    m.parent.mkdir(parents=True)
    m.write_text(json.dumps({"skus": [{"gtin": "0816929000118"}]}), encoding="utf-8")  # bad check digit
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    storage = {"app_id": "local-1", "started_at_ms": 0, "cached": {"clearshelf_fda.enforcement_undeclared"}}
    conn = FakeConn(rows=[])
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    result = gw.warmup()
    assert "not a valid GTIN-13" in result["manifest_error"] and result["cached_now"] == ["clearshelf_fsa.allergy_alerts"]
    assert gw.last_warmup is result and gw.last_app_id is None
    gw.start_warmup = lambda: None
    n = len(conn.sql)
    status, body = gw.run_template(JOIN_MAP)
    assert status == 503 and body["error"].startswith("manifest unreadable") and conn.sql[n:] == []


def test_warmup_reconnects_a_dead_registrar_connection(manifest_with_unregistered_gtin, temp_sql_log):
    class DeadOnce(ShowTablesConn):
        def __init__(self):
            super().__init__()
            self.dead = True

        def execute(self, sql, timeout_s=None, max_rows=None):
            if self.dead:
                self.sql.append(sql)
                raise ZetarisError("connection reset")
            return super().execute(sql, timeout_s, max_rows)

        def close(self):
            self.dead = False

    conn = DeadOnce()
    gw = Gateway(connect=lambda role: conn, storage=lambda: manifest_with_unregistered_gtin)
    result = gw.warmup()
    assert result["cached_now"] == ["clearshelf_off.off_5000254020408"] and result["failed"] == {}
