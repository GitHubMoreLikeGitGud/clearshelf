"""Execution-contract verification for registrar calls (Scout Intent subset, Python side).

The agent signs Scout-style execution contracts (agent/src/contract/scout.ts): HMAC-SHA256
over the canonical JSON of the contract without its `signature`, keyed by
CLEARSHELF_CONTRACT_SECRET. This module checks the same contracts before a registrar call
(register_off, reactivate, refresh_feeds) runs, with the same canonical encoding (a shared
test vector pins it). It is an integrity check, as in Scout's own docs, not
cryptographic-grade security.

    from gateway import contracts
    status, refusal = contracts.check_request(body.get("contract"), "register_off", {"gtin": gtin, "market": market})
    if refusal: return JSONResponse(refusal, status_code=status)   # 403, logged
    ...run the registrar statements...
    contracts.default_verifier().consume(body["contract"])

Every verification, accepted or refused, is appended to data/contracts/verifier-gateway.jsonl
(contract id, action, parameters, verdict; never the secret). A consumed contract id is
recorded in data/contracts/used-gateway.jsonl and refused if presented again.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .jdbc import ROOT

POLICY_PACK_VERSION = "clearshelf-scout-subset@1"
CONTRACT_TTL = timedelta(minutes=15)
CLOCK_SKEW = timedelta(seconds=60)
OFFICER = "officer"
SURFACES = ("clearshelf-ui", "clearshelf-agent")
RISK_CLASSES = {
    "read": "low", "HOLD": "low", "BLOCK": "low", "supplier_draft": "low",
    "register_off": "medium", "refresh_feeds": "medium", "reactivate": "medium",
    "CLEAR": "high", "CLEAR_WITH_STATEMENT": "high", "RELEASE": "high", "free_from_statement": "high",
}
# The registrar runs admin operations only; it never executes a decision.
REGISTRAR_ACTIONS = ("register_off", "reactivate", "refresh_feeds")
CONTRACTS_DIR = ROOT / "data" / "contracts"

_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")
_KEY = re.compile(r"^[\x20-\x7e]+$")
_MAX_SAFE_INT = 2**53 - 1


class ContractError(ValueError):
    pass


def canonical_json(v) -> str:
    """Same encoding as canonicalJson in agent/src/contract/scout.ts: sorted keys at every
    level, no whitespace, strings escaped as JSON.stringify does, safe integers only,
    printable-ASCII keys."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        if abs(v) > _MAX_SAFE_INT:
            raise ContractError(f"canonical JSON allows safe integers only, got {v}")
        return str(v)
    if isinstance(v, float):
        raise ContractError(f"canonical JSON allows safe integers only, got {v!r}")
    if isinstance(v, str):
        if _LONE_SURROGATE.search(v):
            raise ContractError("canonical JSON: lone surrogate in a string")
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str) or not _KEY.match(k):
                raise ContractError(f"canonical JSON: key must be printable ASCII: {k!r}")
        return "{" + ",".join(f"{json.dumps(k)}:{canonical_json(v[k])}" for k in sorted(v)) + "}"
    raise ContractError(f"canonical JSON: unsupported {type(v).__name__}")


def signature_for(contract: dict, secret: str) -> str:
    rest = {k: v for k, v in contract.items() if k != "signature"}
    return hmac.new(secret.encode("utf-8"), canonical_json(rest).encode("utf-8"), hashlib.sha256).hexdigest()


def load_secret() -> str:
    """CLEARSHELF_CONTRACT_SECRET (gateway.jdbc.load_env puts .env.local into the environment)."""
    s = os.environ.get("CLEARSHELF_CONTRACT_SECRET", "")
    if len(s) < 32:
        raise ContractError("CLEARSHELF_CONTRACT_SECRET is not set or shorter than 32 characters")
    return s


def _parse_time(text: str) -> datetime:
    t = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError("time without offset")
    return t


@dataclass(frozen=True)
class Refusal:
    code: str
    reason: str


def _shape_error(c: dict) -> str | None:
    need = ["contractId", "traceId", "intent", "risk", "toolPlan", "scope", "issuedAt", "expiresAt",
            "policyPackVersion", "signature", "signedBy"]
    for k in need:
        if k not in c:
            return f"missing {k}"
    for k in ("contractId", "traceId", "issuedAt", "expiresAt", "policyPackVersion", "signature", "signedBy"):
        if not isinstance(c[k], str):
            return f"{k} must be a string"
    intent = c["intent"]
    if not isinstance(intent, dict) or not isinstance(intent.get("primary"), str) or not isinstance(intent.get("parameters"), dict):
        return "bad intent"
    if any(not isinstance(v, str) for v in intent["parameters"].values()):
        return "intent parameters must be strings"
    risk = c["risk"]
    if not isinstance(risk, dict) or not isinstance(risk.get("level"), str) or not isinstance(risk.get("flags"), list) \
            or not isinstance(risk.get("approvals"), list):
        return "bad risk"
    scope = c["scope"]
    if not isinstance(scope, dict) or not isinstance(scope.get("user"), str) or not isinstance(scope.get("surface"), str) \
            or not isinstance(scope.get("capabilities"), list):
        return "bad scope"
    if not isinstance(c["toolPlan"], list):
        return "bad toolPlan"
    if not re.fullmatch(r"[0-9a-f]{64}", c["signature"]):
        return "signature must be 64 hex characters"
    return None


def _officer_approval(a, issued: datetime, expires: datetime) -> bool:
    if not isinstance(a, dict):
        return False
    if a.get("kind") != "officer-approval" or a.get("by") != OFFICER or a.get("decision") != "approve":
        return False
    if not isinstance(a.get("reason"), str) or not a["reason"].strip():
        return False
    try:
        at = _parse_time(str(a.get("at")))
    except ValueError:
        return False
    return issued - CLOCK_SKEW <= at <= expires


def verify_contract(raw, action: str, params: dict[str, str], secret: str, now: datetime | None = None) -> Refusal | None:
    """None if the contract authorises `action` with `params`, else the Refusal.
    Same checks and order as verifyContract in agent/src/contract/scout.ts."""
    now = now or datetime.now(timezone.utc)
    if raw is None:
        return Refusal("missing", "no execution contract")
    if not isinstance(raw, dict):
        return Refusal("malformed", "contract is not an object")
    shape = _shape_error(raw)
    if shape:
        return Refusal("malformed", shape)
    if raw["signedBy"] != "scout":
        return Refusal("wrong_signer", f"signedBy {raw['signedBy']}")
    if raw["policyPackVersion"] != POLICY_PACK_VERSION:
        return Refusal("wrong_policy_pack", f"policy pack {raw['policyPackVersion']}")
    try:
        expected = signature_for(raw, secret)
    except ContractError as e:
        return Refusal("malformed", str(e))
    if not hmac.compare_digest(expected, raw["signature"]):
        return Refusal("bad_signature", "HMAC does not match the canonical contract")
    try:
        issued, expires = _parse_time(raw["issuedAt"]), _parse_time(raw["expiresAt"])
    except ValueError:
        return Refusal("malformed", "issuedAt/expiresAt are not ISO times")
    if expires - issued > CONTRACT_TTL:
        return Refusal("ttl_too_long", f"TTL {int((expires - issued).total_seconds())} s exceeds 900 s")
    if issued > now + CLOCK_SKEW:
        return Refusal("not_yet_valid", f"issued at {raw['issuedAt']}")
    if now >= expires:
        return Refusal("expired", f"expired at {raw['expiresAt']}")
    if raw["intent"]["primary"] != action:
        return Refusal("wrong_action", f"contract is for {raw['intent']['primary']}, request is {action}")
    level = RISK_CLASSES.get(action)
    if level is None:
        return Refusal("wrong_action", f"unknown action {action}")
    if raw["risk"]["level"] != level:
        return Refusal("risk_mismatch", f"{action} is {level} risk, contract says {raw['risk']['level']}")
    if raw["scope"]["surface"] not in SURFACES:
        return Refusal("out_of_scope", f"surface {raw['scope']['surface']}")
    if action not in raw["scope"]["capabilities"]:
        return Refusal("out_of_scope", f"capability {action} not in the contract scope")
    for k, v in params.items():
        got = raw["intent"]["parameters"].get(k)
        if got != v:
            return Refusal("parameter_mismatch", f"{k}: contract {json.dumps(got)}, request {json.dumps(v)}")
    if level == "high":
        if raw["scope"]["surface"] != "clearshelf-ui":
            return Refusal("approval_missing", "high-risk actions come from the officer UI only")
        if not any(_officer_approval(a, issued, expires) for a in raw["risk"]["approvals"]):
            return Refusal("approval_missing", f"{action} needs an officer approval with a reason")
    return None


class Verifier:
    """verify_contract plus one-shot use and an append-only log."""

    def __init__(self, secret: str, name: str = "gateway", directory: Path | None = CONTRACTS_DIR,
                 clock=lambda: datetime.now(timezone.utc)) -> None:
        if len(secret) < 32:
            raise ContractError("contract secret shorter than 32 characters")
        self._secret = secret
        self.name = name
        self._clock = clock
        self._lock = threading.Lock()
        self._used: set[str] = set()
        self.entries: list[dict] = []
        self.log_path = self.ledger_path = None
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
            self.log_path = directory / f"verifier-{name}.jsonl"
            self.ledger_path = directory / f"used-{name}.jsonl"
            if self.ledger_path.exists():
                for line in self.ledger_path.read_text(encoding="utf-8").splitlines():
                    try:
                        self._used.add(str(json.loads(line)["contract_id"]))
                    except (ValueError, KeyError, TypeError):
                        continue

    def _append(self, path: Path | None, rec: dict) -> None:
        if path is None:
            return
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def verify(self, raw, action: str, params: dict[str, str]) -> Refusal | None:
        now = self._clock()
        with self._lock:
            refusal = verify_contract(raw, action, params, self._secret, now)
            cid = raw.get("contractId") if isinstance(raw, dict) and isinstance(raw.get("contractId"), str) else None
            if refusal is None and cid in self._used:
                refusal = Refusal("replayed", f"contract {cid} was already used")
            entry = {"at": now.isoformat().replace("+00:00", "Z"), "verifier": self.name, "contract_id": cid, "action": action,
                     "params": params, "ok": refusal is None, "code": refusal.code if refusal else None,
                     "reason": refusal.reason if refusal else None}
            self.entries.append(entry)
            del self.entries[:-500]
            self._append(self.log_path, entry)
        return refusal

    def consume(self, contract: dict) -> None:
        with self._lock:
            cid = str(contract["contractId"])
            self._used.add(cid)
            self._append(self.ledger_path, {"contract_id": cid, "action": contract["intent"]["primary"],
                                            "at": self._clock().isoformat().replace("+00:00", "Z"), "verifier": self.name})


_default: Verifier | None = None


def default_verifier() -> Verifier:
    global _default
    if _default is None:
        _default = Verifier(load_secret())
    return _default


def check_request(raw, action: str, params: dict[str, str], verifier: Verifier | None = None) -> tuple[int, dict | None]:
    """(200, None) if the registrar may run `action`; else (403, body) for the HTTP reply.
    The registrar accepts only its own medium-risk actions, never a decision."""
    if action not in REGISTRAR_ACTIONS:
        return 403, {"error": f"refused: the registrar does not run {action}", "code": "wrong_action"}
    try:
        v = verifier or default_verifier()
    except ContractError as e:
        return 403, {"error": f"refused: {e}", "code": "no_secret"}
    refusal = v.verify(raw, action, params)
    if refusal:
        return 403, {"error": f"refused: contract {refusal.code}: {refusal.reason}", "code": refusal.code}
    return 200, None
