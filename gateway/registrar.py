"""The registrar endpoints (SPEC 6): agent-driven Open Food Facts registration, re-activation
and the feed refresh, each under a medium-risk execution contract.

    POST /registrar/register_off   {gtin, market, contract}
    POST /registrar/reactivate     {tables: [...], contract}
    POST /registrar/refresh_feeds  {contract}

Before any statement is sent, the contract is checked for the call's own action and
parameters (gateway/contracts.py: 403 and logged otherwise; a consumed contract is never
accepted again). Statements run one at a time on the gateway's registrar connection under
the registrar allowlist, while the cache warm-up is held off, and each is logged to
data/evidence/sql_log.jsonl.

- register_off runs the per-SKU registration of SPEC 3.2 for a GTIN of the intake manifest's
  catalogue: CREATE LIGHTNING REST TABLE (skipped when the table exists), DESCRIBE, CACHE
  TABLE (Open Food Facts calls at least 2.5 s apart), then re-activates product,
  declared_allergen and recall_product_link. A GTIN outside the manifest is refused (409):
  the activations are generated from the manifest, so a table the manifest does not name
  would never reach the USL.
- reactivate re-runs the activations of the named clearance_usl tables over every
  registered and cached catalogue SKU.
- refresh_feeds runs UNCACHE TABLE then CACHE TABLE on the openFDA and FSA feeds (gate G2c),
  so a live poll sees notices published since the last cache; if UNCACHE is refused, the
  CACHE runs on a fresh connection.
"""

from __future__ import annotations

import threading
from typing import Callable

from . import allowlist, contracts, onboard, sqlgen, templates
from . import manifest as manifest_mod
from .jdbc import ZetarisError
from .sqllog import log_statement, sha256

LOCK_WAIT_S = 600.0
FEED_TIMEOUT_S = 300.0
FEEDS = tuple(f"{db}.{table}" for db, table, _ in onboard.FEEDS)


class RegistrarOnboarder(onboard.Onboarder):
    """The onboarding phases with the registrar's narrower allowlist."""
    ROLE = "registrar"
    SOURCE = "gateway.registrar"


def _bad(code: str, error: str, status: int = 400) -> tuple[int, dict]:
    return status, {"error": error, "code": code}


class Registrar:
    def __init__(self, gateway, verifier: contracts.Verifier | None = None,
                 onboarder: Callable[..., onboard.Onboarder] | None = None) -> None:
        self.gw = gateway
        self._verifier = verifier
        self._onboarder = onboarder or RegistrarOnboarder
        self._lock = threading.Lock()

    # -- shared steps -----------------------------------------------------------

    def _verifier_or_default(self) -> contracts.Verifier:
        return self._verifier or contracts.default_verifier()

    def _check(self, raw, action: str, params: dict[str, str]) -> tuple[int, dict | None]:
        return contracts.check_request(raw, action, params, self._verifier)

    def _consume(self, raw) -> None:
        self._verifier_or_default().consume(raw)

    def _exclusive(self, fn: Callable[[], tuple[int, dict]]) -> tuple[int, dict]:
        """One registrar call at a time, and never while the warm-up sends its CACHE statements."""
        if not self._lock.acquire(timeout=LOCK_WAIT_S):
            return _bad("busy", "another registrar call is running", 503)
        try:
            if not self.gw._warm_lock.acquire(timeout=LOCK_WAIT_S):
                return _bad("busy", "the cache warm-up is running; retry", 503)
            try:
                return fn()
            finally:
                self.gw._warm_lock.release()
        finally:
            self._lock.release()

    def _run_onboarder(self, args: onboard.Args, steps: Callable[[onboard.Onboarder], None]) -> tuple[int, dict, onboard.Onboarder | None]:
        events: list[dict] = []
        try:
            ob = self._onboarder(self.gw.conn("registrar"), args, storage=self.gw._storage, out=events.append)
        except (onboard.OnboardError, manifest_mod.ManifestError) as e:
            return 409, {"error": str(e)[:500], "code": "not_in_manifest"}, None
        try:
            ob.refresh_state()
            steps(ob)
        except (onboard.OnboardError, ZetarisError, allowlist.Refused) as e:
            return 502, {"error": str(e)[:1000], "code": "registrar_failed", "events": events[-20:], "summary": ob.summary}, ob
        return 200, {"events": events[-40:], "summary": ob.summary}, ob

    # -- endpoints --------------------------------------------------------------

    def register_off(self, body: dict) -> tuple[int, dict]:
        gtin, market = body.get("gtin"), body.get("market")
        if not isinstance(gtin, str) or not templates.PARAM_PATTERNS["gtin"].match(gtin) or not sqlgen.gtin_check_digit_ok(gtin):
            return _bad("bad_gtin", "gtin must be a GTIN-13 with a valid check digit")
        if market not in ("UK", "US"):
            return _bad("bad_market", "market must be UK or US")
        status, refusal = self._check(body.get("contract"), "register_off", {"gtin": gtin, "market": market})
        if refusal:
            return status, refusal
        try:
            skus = manifest_mod.select(manifest_mod.load(onboard.MANIFEST), manifest_mod.CATALOGUE_ROLES)
        except (manifest_mod.ManifestError, OSError, ValueError) as e:
            return _bad("manifest", f"intake manifest unreadable: {str(e)[:200]}", 500)
        sku = next((s for s in skus if s.gtin == gtin), None)
        if sku is None:
            return _bad("not_in_manifest", f"{gtin} is not in the intake manifest's catalogue; add it to data/manifest/skus.json first "
                        "(the activations are generated from the manifest)", 409)
        if market not in sku.markets:
            return _bad("market_not_listed", f"{gtin} is listed for {', '.join(sku.markets)}, not {market}", 409)

        def go() -> tuple[int, dict]:
            args = onboard.Args(phases=("off", "activate"), gtins=(gtin,), skip_exists=True, write_files=False)

            def steps(ob: onboard.Onboarder) -> None:
                ob.phase_off()
                ob.phase_activate()

            code, out, _ = self._run_onboarder(args, steps)
            if code == 409:
                return code, out
            self._consume(body["contract"])  # statements were sent: the contract is spent either way
            self.gw._not_registered = (None, frozenset())  # the next warm-up re-checks SHOW TABLES
            table = sqlgen.off_table(gtin)
            return code, {"action": "register_off", "gtin": gtin, "market": market, "table": table,
                          "contract_id": body["contract"]["contractId"], **out}

        return self._exclusive(go)

    def reactivate(self, body: dict) -> tuple[int, dict]:
        tables = body.get("tables")
        if not isinstance(tables, list) or not tables or any(t not in sqlgen.ACTIVATION_ORDER for t in tables):
            return _bad("bad_tables", f"tables must be a non-empty subset of {list(sqlgen.ACTIVATION_ORDER)}")
        wanted = [t for t in sqlgen.ACTIVATION_ORDER if t in tables]
        status, refusal = self._check(body.get("contract"), "reactivate", {"tables": ",".join(wanted)})
        if refusal:
            return status, refusal

        def go() -> tuple[int, dict]:
            args = onboard.Args(phases=("activate",), skip_exists=True, write_files=False)

            def steps(ob: onboard.Onboarder) -> None:
                skus = ob.activation_skus()
                if not skus:
                    raise onboard.OnboardError("no SKU can be activated")
                ob.summary["activated_skus"] = len(skus)
                ob.summary["activated_tables"] = wanted
                for t in wanted:
                    ob.run(sqlgen.activation(t, skus), "activate", "activate", note=t)

            code, out, _ = self._run_onboarder(args, steps)
            self._consume(body["contract"])
            return code, {"action": "reactivate", "tables": wanted, "contract_id": body["contract"]["contractId"], **out}

        return self._exclusive(go)

    def refresh_feeds(self, body: dict) -> tuple[int, dict]:
        status, refusal = self._check(body.get("contract"), "refresh_feeds", {})
        if refusal:
            return status, refusal

        def statement(sql: str, timeout_s: float) -> dict:
            allowlist.check(sql, "registrar")
            entry = {"source_file": "gateway.registrar", "role": "registrar", "sql": sql, "sql_sha256": sha256(sql), "timeout_s": timeout_s}
            try:
                res = self.gw._execute("registrar", sql, timeout_s=timeout_s, rewarm=False)
            except ZetarisError as e:
                log_statement({**entry, "error": str(e)})
                raise
            log_statement({**entry, "elapsed_ms": res.elapsed_ms, "executed_at": res.executed_at, "error": None})
            return {"sql": sql, "elapsed_ms": res.elapsed_ms, "executed_at": res.executed_at}

        def go() -> tuple[int, dict]:
            feeds, failed = [], {}
            for feed in FEEDS:
                rec: dict = {"table": feed}
                try:
                    rec["uncache"] = statement(f"UNCACHE TABLE {feed}", 60.0)
                except ZetarisError as e:
                    rec["uncache_error"] = str(e)[:300]
                    try:  # G2c fallback: CACHE again after a fresh connection
                        self.gw.conn("registrar").close()
                    except Exception:  # noqa: BLE001 - closing a broken connection
                        pass
                try:
                    rec["cache"] = statement(f"CACHE TABLE {feed}", FEED_TIMEOUT_S)
                except ZetarisError as e:
                    failed[feed] = str(e)[:300]
                    rec["cache_error"] = failed[feed]
                feeds.append(rec)
            self._consume(body["contract"])
            out = {"action": "refresh_feeds", "contract_id": body["contract"]["contractId"], "feeds": feeds, "failed": failed}
            return (502 if failed else 200), out

        return self._exclusive(go)
