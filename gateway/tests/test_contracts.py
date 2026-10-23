import json
from datetime import datetime, timedelta, timezone

import pytest

from gateway import contracts
from gateway.contracts import (POLICY_PACK_VERSION, ContractError, Verifier, canonical_json, check_request,
                               signature_for, verify_contract)

# Test secret only, shared with agent/test/fixtures/contract-vector.ts.
SECRET = "test" * 10
T0 = datetime(2026, 10, 25, 10, 0, 0, tzinfo=timezone.utc)

# The same contract as agent/test/fixtures/contract-vector.ts; both sides must give VECTOR_SIGNATURE.
VECTOR = {
    "contractId": "c-vector-0001",
    "traceId": "t-vector",
    "intent": {"primary": "register_off",
               "parameters": {"gtin": "0816929000119", "market": "UK", "note": "Café \"quoted\" \\ tab\t line\n é ü \U0001F36B"}},
    "risk": {"level": "medium", "flags": ["vector"], "approvals": []},
    "toolPlan": [{"tool": "registrar.register_off", "input": {"gtin": "0816929000119"}}],
    "scope": {"user": "clearshelf-agent", "surface": "clearshelf-agent", "capabilities": ["register_off"]},
    "issuedAt": "2026-10-25T10:00:00.000Z",
    "expiresAt": "2026-10-25T10:15:00.000Z",
    "policyPackVersion": POLICY_PACK_VERSION,
    "signedBy": "scout",
}
VECTOR_SIGNATURE = "40f4378db94975f9d918ee7e4be2edff6a3ee17a078b392fbc03a26af0ff98b2"


def signed(c: dict) -> dict:
    return {**c, "signature": signature_for(c, SECRET)}


def contract(action="register_off", params=None, level=None, surface="clearshelf-agent", approvals=None,
             issued=T0, ttl=timedelta(minutes=15)) -> dict:
    params = params if params is not None else {"gtin": "0816929000119", "market": "UK"}
    return signed({
        "contractId": "c-test-1", "traceId": "t-test",
        "intent": {"primary": action, "parameters": params},
        "risk": {"level": level or contracts.RISK_CLASSES[action], "flags": [], "approvals": approvals or []},
        "toolPlan": [{"tool": f"registrar.{action}", "input": params}],
        "scope": {"user": "clearshelf-agent", "surface": surface, "capabilities": [action]},
        "issuedAt": issued.isoformat().replace("+00:00", "Z"),
        "expiresAt": (issued + ttl).isoformat().replace("+00:00", "Z"),
        "policyPackVersion": POLICY_PACK_VERSION, "signedBy": "scout",
    })


def test_shared_vector_matches_typescript():
    assert signature_for(VECTOR, SECRET) == VECTOR_SIGNATURE


def test_canonical_json_rules():
    assert canonical_json({"b": 1, "a": {"d": [1, "x"], "c": None}}) == '{"a":{"c":null,"d":[1,"x"]},"b":1}'
    assert canonical_json({"s": 'é"\\\n\u0001'}) == '{"s":"é\\"\\\\\\n\\u0001"}'
    with pytest.raises(ContractError):
        canonical_json({"x": 1.5})
    with pytest.raises(ContractError):
        canonical_json({"x": "\ud800"})
    with pytest.raises(ContractError):
        canonical_json({"é": 1})


def test_accepts_a_valid_registrar_contract():
    assert verify_contract(contract(), "register_off", {"gtin": "0816929000119", "market": "UK"}, SECRET, T0 + timedelta(seconds=5)) is None


@pytest.mark.parametrize("mutate,code", [
    (lambda c: {**c, "intent": {**c["intent"], "parameters": {"gtin": "0850041392103", "market": "UK"}}}, "bad_signature"),
    (lambda c: {**c, "signedBy": "someone"}, "wrong_signer"),
    (lambda c: {k: v for k, v in c.items() if k != "signature"}, "malformed"),
    (lambda c: None, "missing"),
])
def test_refuses_tampered_or_missing(mutate, code):
    r = verify_contract(mutate(contract()), "register_off", {"gtin": "0850041392103", "market": "UK"}, SECRET, T0)
    assert r is not None and r.code == code


def test_refuses_expired_early_long_ttl_and_wrong_secret():
    p = {"gtin": "0816929000119", "market": "UK"}
    assert verify_contract(contract(), "register_off", p, SECRET, T0 + timedelta(minutes=15)).code == "expired"
    assert verify_contract(contract(), "register_off", p, SECRET, T0 - timedelta(minutes=5)).code == "not_yet_valid"
    assert verify_contract(contract(ttl=timedelta(minutes=16)), "register_off", p, SECRET, T0).code == "ttl_too_long"
    assert verify_contract(contract(), "register_off", p, SECRET + "x", T0).code == "bad_signature"


def test_refuses_wrong_action_parameters_and_risk():
    p = {"gtin": "0816929000119", "market": "UK"}
    assert verify_contract(contract(), "reactivate", p, SECRET, T0).code == "wrong_action"
    assert verify_contract(contract(), "register_off", {**p, "market": "US"}, SECRET, T0).code == "parameter_mismatch"
    assert verify_contract(contract(level="low"), "register_off", p, SECRET, T0).code == "risk_mismatch"


def test_high_risk_needs_officer_approval_on_the_ui_surface():
    p = {"gtin": "0816929000119", "market": "UK", "status": "CLEAR"}
    no_approval = contract("CLEAR", p, surface="clearshelf-ui")
    assert verify_contract(no_approval, "CLEAR", p, SECRET, T0).code == "approval_missing"
    approval = [{"kind": "officer-approval", "by": "officer", "at": "2026-10-25T10:00:00.000Z", "decision": "approve", "reason": "label checked"}]
    assert verify_contract(contract("CLEAR", p, surface="clearshelf-ui", approvals=approval), "CLEAR", p, SECRET, T0) is None
    assert verify_contract(contract("CLEAR", p, surface="clearshelf-agent", approvals=approval), "CLEAR", p, SECRET, T0).code == "approval_missing"


def test_verifier_logs_consumes_and_refuses_replay(tmp_path):
    v = Verifier(SECRET, "test", tmp_path, clock=lambda: T0 + timedelta(seconds=1))
    c = contract()
    p = {"gtin": "0816929000119", "market": "UK"}
    assert v.verify(c, "register_off", p) is None
    v.consume(c)
    assert v.verify(c, "register_off", p).code == "replayed"
    log = [json.loads(line) for line in (tmp_path / "verifier-test.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(e["ok"], e["code"]) for e in log] == [(True, None), (False, "replayed")]
    assert SECRET not in (tmp_path / "verifier-test.jsonl").read_text(encoding="utf-8")
    assert Verifier(SECRET, "test", tmp_path, clock=lambda: T0).verify(c, "register_off", p).code == "replayed"


def test_check_request_refuses_decisions_and_bad_contracts(tmp_path):
    v = Verifier(SECRET, "test", tmp_path, clock=lambda: T0 + timedelta(seconds=1))
    status, body = check_request(contract(), "RELEASE", {"gtin": "0816929000119"}, verifier=v)
    assert status == 403 and body["code"] == "wrong_action"
    status, body = check_request(None, "register_off", {"gtin": "0816929000119", "market": "UK"}, verifier=v)
    assert status == 403 and body["code"] == "missing"
    assert check_request(contract(), "register_off", {"gtin": "0816929000119", "market": "UK"}, verifier=v) == (200, None)
