"""Registrar endpoints: contract first, then the registrar statements (fake Zetaris; synthetic data)."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from gateway import app as app_module
from gateway import contracts, onboard, registrar, sqlgen
from gateway.app import Gateway, create_app
from gateway.contracts import POLICY_PACK_VERSION, Verifier, signature_for
from gateway.jdbc import ZetarisError

from .test_onboard import MANIFEST_SKUS, FakeZetaris, repo  # noqa: F401 - the repo fixture

SECRET = "test" * 10


def contract(action, params, cid="c-reg-1", issued=None):
    issued = issued or datetime.now(timezone.utc)
    c = {
        "contractId": cid, "traceId": "t-reg",
        "intent": {"primary": action, "parameters": params},
        "risk": {"level": contracts.RISK_CLASSES[action], "flags": [], "approvals": []},
        "toolPlan": [{"tool": f"registrar.{action}", "input": params}],
        "scope": {"user": "clearshelf-agent", "surface": "clearshelf-agent", "capabilities": [action]},
        "issuedAt": issued.isoformat().replace("+00:00", "Z"),
        "expiresAt": (issued + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        "policyPackVersion": POLICY_PACK_VERSION, "signedBy": "scout",
    }
    return {**c, "signature": signature_for(c, SECRET)}


class Conn(FakeZetaris):
    def __init__(self, *a, fail_uncache=False, **kw):
        super().__init__(*a, **kw)
        self.fail_uncache = fail_uncache
        self.closed = 0

    def execute(self, sql, timeout_s=None, max_rows=None):
        if self.fail_uncache and sql.startswith("UNCACHE"):
            self.sql.append(sql)
            raise ZetarisError("UNCACHE not accepted")
        return super().execute(sql, timeout_s, max_rows)

    def close(self):
        self.closed += 1


@pytest.fixture
def setup(repo, tmp_path, monkeypatch):  # noqa: F811 - pytest fixture injection
    monkeypatch.setattr(app_module, "ROOT", repo)
    conn = Conn(off_tables=["off_0816929000119"])
    storage = {"app_id": "local-1", "cached": {"clearshelf_off.off_0816929000119", "clearshelf_off.off_0072992042603"}}
    gw = Gateway(connect=lambda role: conn, storage=lambda: storage)
    gw.start_warmup = lambda: None
    verifier = Verifier(SECRET, name="test", directory=tmp_path / "contracts")
    reg = registrar.Registrar(gw, verifier=verifier)
    client = TestClient(create_app(gw, warm_on_start=False, registrar=reg))
    return client, conn, storage, verifier


def sent(conn):
    return [s for s in conn.sql if not s.startswith(("SHOW", "LIST DQ"))]


def test_every_registrar_call_needs_its_own_contract_and_sends_nothing_without_it(setup):
    client, conn, _, verifier = setup
    for path, body in [("/registrar/register_off", {"gtin": "0072992042603", "market": "US"}),
                       ("/registrar/reactivate", {"tables": ["product"]}),
                       ("/registrar/refresh_feeds", {})]:
        r = client.post(path, json=body)
        assert r.status_code == 403 and r.json()["code"] == "missing"
    # A contract for another action or other parameters is refused too.
    r = client.post("/registrar/register_off", json={"gtin": "0072992042603", "market": "US",
                                                     "contract": contract("register_off", {"gtin": "0816929000119", "market": "UK"})})
    assert r.status_code == 403 and r.json()["code"] == "parameter_mismatch"
    r = client.post("/registrar/refresh_feeds", json={"contract": contract("reactivate", {"tables": "product"})})
    assert r.status_code == 403 and r.json()["code"] == "wrong_action"
    assert conn.sql == []
    assert [e["ok"] for e in verifier.entries] == [False] * 5


def test_register_off_creates_describes_caches_and_reactivates_once(setup, monkeypatch):
    client, conn, storage, _ = setup
    monkeypatch.setattr(onboard.time, "sleep", lambda s: None)

    def cache_effect(original=conn.execute):
        def run(sql, timeout_s=None, max_rows=None):
            res = original(sql, timeout_s, max_rows)
            if sql.startswith("CACHE TABLE "):
                storage["cached"].add(sql.split()[-1].lower())
            return res
        return run
    conn.execute = cache_effect()
    storage["cached"].discard("clearshelf_off.off_0072992042603")
    c = contract("register_off", {"gtin": "0072992042603", "market": "US"})
    r = client.post("/registrar/register_off", json={"gtin": "0072992042603", "market": "US", "contract": c})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["table"] == "clearshelf_off.off_0072992042603" and body["contract_id"] == "c-reg-1"
    s = sent(conn)
    assert s[0].startswith("CREATE LIGHTNING REST TABLE off_0072992042603 FROM CLEARSHELF_OFF")
    assert s[1] == "DESCRIBE clearshelf_off.off_0072992042603"
    assert s[2] == "CACHE TABLE clearshelf_off.off_0072992042603"
    acts = [x for x in s if x.startswith("ACTIVATE")]
    assert [x.split()[3].split(".")[-1] for x in acts] == list(sqlgen.SKU_TABLES)
    # The rest are DESCRIBEs of the other registered catalogue SKUs (no source call).
    assert all(x.startswith(("ACTIVATE", "DESCRIBE")) for x in s[3:])
    assert all(x.startswith("ACTIVATE USL TABLE lightning.metastore.clearshelf.clearance_usl.") for x in acts)
    # One-shot: the same contract is refused afterwards, and nothing more is sent.
    n = len(conn.sql)
    again = client.post("/registrar/register_off", json={"gtin": "0072992042603", "market": "US", "contract": c})
    assert again.status_code == 403 and again.json()["code"] == "replayed"
    assert len(conn.sql) == n


def test_register_off_refuses_a_gtin_outside_the_manifest_catalogue(setup):
    client, conn, _, _ = setup
    for gtin, market, code in [("0041383090738", "UK", "not_in_manifest"),  # eval_only role
                               ("0012345678905", "UK", "not_in_manifest"),
                               ("0816929000119", "US", "market_not_listed")]:
        r = client.post("/registrar/register_off", json={"gtin": gtin, "market": market, "contract": contract("register_off", {"gtin": gtin, "market": market}, cid=f"c-{gtin}")})
        assert r.status_code == 409 and r.json()["code"] == code
    assert sent(conn) == []
    r = client.post("/registrar/register_off", json={"gtin": "0816929000118", "market": "UK"})
    assert r.status_code == 400 and r.json()["code"] == "bad_gtin"


def test_reactivate_runs_the_named_activations_in_order(setup):
    client, conn, _, _ = setup
    c = contract("reactivate", {"tables": "product,declared_allergen"})
    r = client.post("/registrar/reactivate", json={"tables": ["declared_allergen", "product"], "contract": c})
    assert r.status_code == 200, r.text
    assert [x.split()[3].split(".")[-1] for x in sent(conn) if x.startswith("ACTIVATE")] == ["product", "declared_allergen"]
    bad = client.post("/registrar/reactivate", json={"tables": ["decision; DROP"], "contract": c})
    assert bad.status_code == 400


def test_refresh_feeds_uncaches_then_caches_each_feed_and_falls_back_on_a_fresh_connection(setup):
    client, conn, _, _ = setup
    r = client.post("/registrar/refresh_feeds", json={"contract": contract("refresh_feeds", {})})
    assert r.status_code == 200, r.text
    assert conn.sql == ["UNCACHE TABLE clearshelf_fda.enforcement_undeclared", "CACHE TABLE clearshelf_fda.enforcement_undeclared",
                        "UNCACHE TABLE clearshelf_fsa.allergy_alerts", "CACHE TABLE clearshelf_fsa.allergy_alerts"]
    conn.sql.clear()
    conn.fail_uncache = True
    r = client.post("/registrar/refresh_feeds", json={"contract": contract("refresh_feeds", {}, cid="c-reg-2")})
    assert r.status_code == 200
    assert [f["uncache_error"] for f in r.json()["feeds"]] == ["UNCACHE not accepted"] * 2
    assert conn.closed == 2 and [s for s in conn.sql if s.startswith("CACHE")] == ["CACHE TABLE clearshelf_fda.enforcement_undeclared", "CACHE TABLE clearshelf_fsa.allergy_alerts"]


def test_statements_are_logged_with_the_registrar_role(setup, temp_sql_log):
    client, _, _, _ = setup
    client.post("/registrar/refresh_feeds", json={"contract": contract("refresh_feeds", {})})
    rows = [json.loads(x) for x in temp_sql_log.read_text(encoding="utf-8").splitlines()]
    assert rows and all(x["role"] == "registrar" and x["source_file"] == "gateway.registrar" for x in rows)
