"""ClearShelf Zetaris gateway: named read templates over JDBC, on 127.0.0.1:8791.

    .venv/Scripts/python -m gateway.app

Endpoints (this module): GET /health, POST /sql/template.
The agent sends a template id and parameters, never SQL text.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import allowlist, cache, templates
from . import manifest as manifest_mod
from .jdbc import ROOT, LightningConnection, QueryTimeout, ZetarisError, load_env
from .sqllog import log_statement, sha256

MAX_ROWS = 200
FETCH_LIMIT = 10_000
QUERY_TIMEOUT_S = float(os.environ.get("GATEWAY_QUERY_TIMEOUT_S", "60"))
OFF_SPACING_S = 3.0
OFF_DB = "clearshelf_off"
SHOW_TIMEOUT_S = 30.0
CACHE_TIMEOUT_S = 300.0
RETRY_BASE_S = 60.0  # a failed CACHE waits this long before the next try, doubling each time
RETRY_MAX_S = 900.0
TEMPLATE_ROLES = ("reader", "registrar")
FEEDS = ("clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts")


class TemplateRequest(BaseModel):
    template_id: str
    params: dict[str, str] = Field(default_factory=dict)
    role: str = "reader"


def cache_targets() -> list[str]:
    """Raw tables the warm-up keeps cached: the two feeds plus the OFF table of
    every catalogue SKU (manifest.CATALOGUE_ROLES) in the intake manifest, the
    set `gateway.onboard` activates by default. Eval-only SKUs never enter the
    demo catalogue. Every OFF table in the `product` activation must be cached,
    or each read of the USL calls Open Food Facts for it. A manifest GTIN may not
    be registered yet; the warm-up skips those (see Gateway.registered_off).
    Raises manifest.ManifestError if the manifest is missing or unreadable."""
    path = ROOT / "data" / "manifest" / "skus.json"
    try:
        skus = manifest_mod.select(manifest_mod.load(path), manifest_mod.CATALOGUE_ROLES)
    except manifest_mod.ManifestError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise manifest_mod.ManifestError(f"{path.name}: {e}") from e
    return list(FEEDS) + [f"{OFF_DB}.off_{s.gtin}" for s in skus]


class Gateway:
    """One persistent connection per role, each behind its own lock."""

    def __init__(self, connect: Callable[[str], LightningConnection] | None = None,
                 storage: Callable[[], dict | None] | None = None) -> None:
        self._connect = connect or self._default_connect
        self._storage = storage or cache.spark_storage
        self._conns: dict[str, LightningConnection] = {}
        self._lock = threading.Lock()
        self._warm_lock = threading.Lock()
        self.reader_mode = "not_connected"
        self.last_app_id: str | None = None  # driver app whose warm-up left nothing failed or waiting
        self.last_warmup: dict | None = None
        self._not_registered: tuple[str | None, frozenset[str]] = (None, frozenset())  # (app id, from SHOW TABLES)
        self._retry: dict[str, tuple[int, float]] = {}  # target -> (failures so far, earliest next try)
        self._clock: Callable[[], float] = time.monotonic

    # -- connections --------------------------------------------------------

    def _default_connect(self, role: str) -> LightningConnection:
        if role == "reader":
            user = os.environ.get("ZETARIS_READER_USERNAME", "")
            pw = os.environ.get("ZETARIS_READER_PASSWORD", "")
            if user and len(pw) >= 8:  # Zetaris passwords are at least 8 characters
                c = LightningConnection(user, pw, name="reader")
                try:
                    c.connect()
                    self.reader_mode = "reader_user"
                    return c
                except ZetarisError:
                    self.reader_mode = "admin_fallback: reader login failed"
            else:
                self.reader_mode = "admin_fallback: no reader credentials"
        c = LightningConnection.from_env("admin")
        c.name = role
        return c

    def conn(self, role: str) -> LightningConnection:
        with self._lock:
            if role not in self._conns:
                self._conns[role] = self._connect(role)
            return self._conns[role]

    def _execute(self, role: str, sql: str, timeout_s: float, max_rows: int | None = None, rewarm: bool = True):
        """Execute; if it fails and the connection no longer answers SELECT 1,
        reconnect once and retry. A reconnect asks for a warm-up, which runs only
        if the driver restarted (the cache is driver-wide, not per session)."""
        c = self.conn(role)
        try:
            return c.execute(sql, timeout_s=timeout_s, max_rows=max_rows)
        except QueryTimeout:
            raise
        except ZetarisError as first:
            alive = True
            try:
                c.execute("SELECT 1", timeout_s=10)
            except ZetarisError:
                alive = False
            if alive:
                raise first
            c.close()
            if rewarm:
                self.start_warmup()
            return c.execute(sql, timeout_s=timeout_s, max_rows=max_rows)

    # -- warm-up ------------------------------------------------------------

    def registered_off(self) -> set[str] | None:
        """Lower-cased clearshelf_off.<table> names that exist, from SHOW TABLES
        (no source call). None if the statement fails."""
        sql = f"SHOW TABLES IN {OFF_DB}"
        allowlist.check(sql, "registrar")
        entry = {"source_file": "gateway.warmup", "role": "registrar", "sql": sql, "timeout_s": SHOW_TIMEOUT_S}
        try:
            res = self._execute("registrar", sql, timeout_s=SHOW_TIMEOUT_S, rewarm=False)
        except ZetarisError as e:
            log_statement({**entry, "error": str(e)})
            return None
        log_statement({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count,
                       "executed_at": res.executed_at, "error": None})
        return {f"{OFF_DB}.{str(r[0]).split('.')[-1].lower()}" for r in res.rows if r and r[0]}

    def _pending(self, targets: list[str], storage: dict) -> list[str]:
        """Targets the driver does not hold, less the OFF tables that the last
        SHOW TABLES on this driver app did not list (no activation reads those)."""
        app_id, unregistered = self._not_registered
        skip = unregistered if app_id == storage["app_id"] else frozenset()
        return [t for t in targets if t.lower() not in storage["cached"] and t not in skip]

    def warmup(self, force: bool = False) -> dict:
        """CACHE TABLE every target that the driver does not hold in memory and
        that is registered. A call for the driver app already warmed sends
        nothing while every target is cached. A failed CACHE leaves the app not
        warmed; later calls retry it after RETRY_BASE_S, doubling up to
        RETRY_MAX_S (force retries now). OFF tables are spaced at least
        OFF_SPACING_S apart. Registering new SKUs is the registrar's job."""
        if not self._warm_lock.acquire(blocking=False):
            return {"skipped": "warm-up already running"}
        try:
            storage = self._storage()
            if storage is None:
                self.last_warmup = {"at": cache.now_iso(), "skipped": "spark ui unreachable"}
                return self.last_warmup
            app_id = storage["app_id"]
            manifest_error = None
            try:
                targets = cache_targets()
            except manifest_mod.ManifestError as e:
                targets, manifest_error = list(FEEDS), str(e)[:300]
            for t in [t for t in self._retry if t.lower() in storage["cached"]]:
                del self._retry[t]
            pending = self._pending(targets, storage)
            if not force and not pending and manifest_error is None and app_id == self.last_app_id:
                return {"skipped": f"already warmed for driver app {app_id}"}
            now = self._clock()
            waiting = {t: round(self._retry[t][1] - now, 1) for t in pending
                       if not force and t in self._retry and self._retry[t][1] > now}
            todo = [t for t in pending if t not in waiting]
            missing = [t for t in targets if t.lower() not in storage["cached"]]
            not_registered = [t for t in missing if t not in pending]
            if any(t.startswith(OFF_DB + ".") for t in todo):
                registered = self.registered_off()
                shown = registered is not None
                if not shown:  # fall back to tables cached successfully before
                    registered = {o for o in cache.last_cache_events() if o.startswith(OFF_DB + ".")}
                not_registered = [t for t in missing if t.startswith(OFF_DB + ".") and t.lower() not in registered]
                if shown:  # a guess from the log never lets a template read past the gate
                    self._not_registered = (app_id, frozenset(not_registered))
                todo = [t for t in todo if t not in not_registered]
            done, failed = [], {}
            for t in todo:
                sql = f"CACHE TABLE {t}"
                allowlist.check(sql, "registrar")
                if t.startswith(OFF_DB + "."):
                    time.sleep(OFF_SPACING_S)
                entry = {"source_file": "gateway.warmup", "role": "registrar", "sql": sql, "timeout_s": CACHE_TIMEOUT_S}
                try:
                    res = self._execute("registrar", sql, timeout_s=CACHE_TIMEOUT_S, rewarm=False)
                    entry.update(elapsed_ms=res.elapsed_ms, executed_at=res.executed_at, error=None)
                    done.append(t)
                    self._retry.pop(t, None)
                except ZetarisError as e:
                    entry.update(error=str(e))
                    failed[t] = str(e)[:200]
                    n = self._retry.get(t, (0, 0.0))[0] + 1
                    self._retry[t] = (n, self._clock() + min(RETRY_BASE_S * 2 ** (n - 1), RETRY_MAX_S))
                log_statement(entry)
            result = {"at": cache.now_iso(), "app_id": app_id,
                      "already_cached": sum(1 for t in targets if t.lower() in storage["cached"]),
                      "cached_now": done, "failed": failed, "retry_in_s": waiting, "not_registered": sorted(not_registered)}
            if manifest_error is not None:
                result["manifest_error"] = manifest_error
            if not failed and not waiting and manifest_error is None:
                self.last_app_id = app_id
            self.last_warmup = result
            return result
        finally:
            self._warm_lock.release()

    def start_warmup(self) -> None:
        if self._warm_lock.locked():
            return
        threading.Thread(target=self.warmup, daemon=True, name="gateway-warmup").start()

    # -- endpoints ----------------------------------------------------------

    def health(self) -> dict:
        out: dict = {"ok": False, "service": "clearshelf-gateway", "checked_at": cache.now_iso()}
        try:
            res = self._execute("reader", "SELECT 1", timeout_s=15)
            out["zetaris"] = {"select1": res.rows[0][0] if res.rows else None, "elapsed_ms": res.elapsed_ms}
            out["ok"] = bool(res.rows and res.rows[0][0] == 1)
        except ZetarisError as e:
            out["zetaris"] = {"error": str(e)[:300]}
        out["reader_mode"] = self.reader_mode
        storage = self._storage()
        out["cache"] = (
            {"app_id": storage["app_id"], "cached_tables": sorted(storage["cached"])} if storage else {"error": "spark ui unreachable"}
        )
        out["templates"] = sorted(templates.TEMPLATES)
        out["last_warmup"] = self.last_warmup
        return out

    def run_template(self, req: TemplateRequest) -> tuple[int, dict]:
        out: dict = {
            "template_id": req.template_id, "role": req.role, "columns": [], "rows": [], "row_count": 0,
            "truncated": False, "elapsed_ms": 0, "sql": None, "sql_sha256": None, "objects": [], "raw_objects": [],
            "executed_at": cache.now_iso(), "cache_state": "unknown", "cache_detail": {}, "source_cached_at": {}, "error": None,
        }
        if req.role not in TEMPLATE_ROLES:
            out["error"] = f"role must be one of {TEMPLATE_ROLES}"
            return 400, out
        try:
            t, sql = templates.render(req.template_id, req.params)
        except templates.BadParams as e:
            out["error"] = str(e)
            return 400, out
        out.update(sql=sql, sql_sha256=sha256(sql), objects=list(t.objects), raw_objects=cache.resolve(t.raw_objects, req.params))
        log = {"source_file": "gateway.template", "template_id": t.id, "role": req.role, "params": req.params,
               "sql": sql, "sql_sha256": out["sql_sha256"], "timeout_s": QUERY_TIMEOUT_S}
        try:
            allowlist.check(sql, req.role)
        except allowlist.Refused as e:
            out["error"] = f"refused: {e}"
            log_statement({**log, "error": out["error"], "refused": True})
            return 403, out
        storage = self._storage()
        off_targets: list[str] | None = None
        hold, uncached_off = None, []
        if storage is not None:
            try:
                targets = cache_targets()
            except manifest_mod.ManifestError as e:
                targets = list(FEEDS)
                hold = f"manifest unreadable, so the Open Food Facts tables to check are unknown: {str(e)[:200]}"
            pending = self._pending(targets, storage)
            if pending or storage["app_id"] != self.last_app_id:
                self.start_warmup()  # first run, driver restart, evicted or failed CACHE
            off_targets = [o for o in targets if o.startswith(OFF_DB + ".")]
            off_targets = [o for o in off_targets if o in pending or o.lower() in storage["cached"]]
            uncached_off = [o for o in pending if o.startswith(OFF_DB + ".")]
            if uncached_off and hold is None:
                hold = (f"warming: {len(uncached_off)} Open Food Facts table(s) not cached yet "
                        f"({', '.join(uncached_off[:3])}{', ...' if len(uncached_off) > 3 else ''}); retry after the warm-up")
        state, detail, cached_at = cache.cache_state(t.raw_objects, req.params, storage, off_targets)
        out.update(cache_state=state, cache_detail=detail, source_cached_at=cached_at)
        if hold and templates.OFF_RAW in t.raw_objects:
            # An uncached OFF table in the product union is fetched from Open Food Facts on every read, unspaced.
            out.update(error=hold, cache_state="miss", cache_detail={**detail, **{o: "miss" for o in uncached_off}})
            log_statement({**log, "error": hold, "sent": False, "cache_state": "miss"})
            return 503, out
        status = 200
        try:
            res = self._execute(req.role, sql, timeout_s=QUERY_TIMEOUT_S, max_rows=FETCH_LIMIT)
            out.update(columns=res.columns, rows=res.rows[:MAX_ROWS], row_count=res.row_count,
                       truncated=res.row_count > MAX_ROWS, elapsed_ms=res.elapsed_ms, executed_at=res.executed_at)
        except QueryTimeout as e:
            out["error"], status = f"timeout: {e}", 504
        except ZetarisError as e:
            out["error"], status = str(e)[:1000], 502
        log_statement({**log, "elapsed_ms": out["elapsed_ms"], "row_count": out["row_count"], "executed_at": out["executed_at"],
                       "cache_state": state, "error": out["error"]})
        return status, out


def create_app(gateway: Gateway | None = None, warm_on_start: bool = True) -> FastAPI:
    load_env()
    gw = gateway or Gateway()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if warm_on_start:
            gw.start_warmup()
        yield

    api = FastAPI(title="ClearShelf Zetaris gateway", version="0.1.0", lifespan=lifespan)
    api.state.gateway = gw

    @api.get("/health")
    def health() -> JSONResponse:
        body = gw.health()
        return JSONResponse(body, status_code=200 if body["ok"] else 503)

    @api.post("/sql/template")
    def sql_template(req: TemplateRequest) -> JSONResponse:
        status, body = gw.run_template(req)
        return JSONResponse(body, status_code=status)

    return api


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("gateway.app:app", host="127.0.0.1", port=8791, log_level="info")
