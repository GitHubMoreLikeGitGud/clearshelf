import json

import pytest
from fastapi.testclient import TestClient

from gateway import app as app_module
from gateway.app import Gateway, create_app
from gateway.jdbc import QueryResult, QueryTimeout, ZetarisError

STORAGE = {"app_id": "local-1", "started_at_ms": 0,
           "cached": {"clearshelf_fda.enforcement_undeclared", "clearshelf_off.off_0816929000119"}}
CONTRACT_KEYS = {"columns", "rows", "row_count", "elapsed_ms", "sql", "sql_sha256", "objects", "executed_at", "cache_state", "error"}


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
    """SHOW TABLES IN clearshelf_off lists two registered OFF tables; CACHE succeeds."""

    def __init__(self, show_fails=False):
        super().__init__(rows=[])
        self.show_fails = show_fails

    def execute(self, sql, timeout_s=None, max_rows=None):
        self.sql.append(sql)
        if sql.startswith("SHOW TABLES"):
            if self.show_fails:
                raise ZetarisError("connection reset")
            return QueryResult(sql=sql, columns=["table_identifier", "catalog_name", "catalog_type"], rows=SHOW_OFF_ROWS,
                               row_count=len(SHOW_OFF_ROWS), elapsed_ms=40, executed_at="2026-10-23T08:00:00+0800")
        return QueryResult(sql=sql, rows=[], elapsed_ms=5, executed_at="2026-10-23T08:00:00+0800")


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
    assert conn.sql == ["SHOW TABLES IN clearshelf_off", "CACHE TABLE clearshelf_off.off_5000254020408"]
    assert result["not_registered"] == ["clearshelf_off.off_4056489125839"]


def test_warmup_skips_show_tables_when_no_off_table_is_missing(manifest_with_unregistered_gtin):
    storage = dict(manifest_with_unregistered_gtin)
    storage["cached"] = storage["cached"] | {"clearshelf_off.off_5000254020408", "clearshelf_off.off_4056489125839"}
    conn = ShowTablesConn()
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    assert gw.warmup()["cached_now"] == [] and conn.sql == []


def test_cache_targets_skip_eval_only_skus(tmp_path, monkeypatch):
    m = tmp_path / "data" / "manifest" / "skus.json"
    m.parent.mkdir(parents=True)
    m.write_text(json.dumps({"skus": [{"gtin": "0816929000119", "role": "demo"},
                                      {"gtin": "0041383090738", "role": "eval_only"},
                                      {"gtin": "4056489125839"}]}), encoding="utf-8")
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    targets = app_module.cache_targets()
    assert "clearshelf_off.off_0816929000119" in targets and "clearshelf_off.off_4056489125839" in targets
    assert "clearshelf_off.off_0041383090738" not in targets
