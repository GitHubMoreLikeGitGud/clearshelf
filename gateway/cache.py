"""Cache state of the raw REST tables, read from the Zetaris driver's Spark UI.

Measured on 2026-10-23 (Zetaris 2.4.3.1): CACHE TABLE is held by the driver,
not the JDBC session. A table cached on one connection answers from cache on
a new connection and after the first connection closes. `SHOW CACHE TABLES`
returned no rows. The Spark UI storage API (127.0.0.1:4040, read-only) lists
each cached table as an "In-memory table <db>.<table>" RDD, so it is used as
the source of truth. A driver restart drops every cache; the app id changes.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.request import urlopen

from .sqllog import LOG_PATH

SPARK_UI = os.environ.get("ZETARIS_SPARK_UI", "http://127.0.0.1:4040")
_CACHE_STMT = re.compile(r"^\s*CACHE\s+TABLE\s+(clearshelf_[a-z]+\.[A-Za-z0-9_]+)\s*$", re.I)


def spark_storage(timeout: float = 2.0) -> dict | None:
    """{"app_id", "started_at_ms", "cached": set[str]} or None if the UI is unreachable."""
    try:
        with urlopen(f"{SPARK_UI}/api/v1/applications", timeout=timeout) as r:
            apps = json.loads(r.read().decode())
        app = apps[0]
        with urlopen(f"{SPARK_UI}/api/v1/applications/{app['id']}/storage/rdd", timeout=timeout) as r:
            rdds = json.loads(r.read().decode())
    except Exception:
        return None
    cached = set()
    for rdd in rdds:
        name = str(rdd.get("name", ""))
        if name.startswith("In-memory table ") and rdd.get("numCachedPartitions", 0) > 0:
            cached.add(name[len("In-memory table "):].strip().lower())
    started = app.get("attempts", [{}])[0].get("startTimeEpoch")
    return {"app_id": app["id"], "started_at_ms": started, "cached": cached}


def _parse_ts(text: str) -> datetime | None:
    for fmt in ("%Y-%m-%dT%H:%M:%S%z",):
        try:
            return datetime.strptime(text, fmt)
        except (TypeError, ValueError):
            pass
    return None


def last_cache_events(since_ms: int | None = None, path=None) -> dict[str, str]:
    """Latest successful CACHE TABLE time per object from the SQL log, ignoring
    events before the driver started (they were lost with the old driver)."""
    path = path or LOG_PATH
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    floor = datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc) if since_ms else None
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            m = _CACHE_STMT.match(rec.get("sql", "") or "")
            if not m or rec.get("error"):
                continue
            ts_text = rec.get("executed_at") or rec.get("logged_at")
            ts = _parse_ts(ts_text)
            if floor and ts and ts < floor:
                continue
            out[m.group(1).lower()] = ts_text
    return out


def resolve(raw_objects: tuple[str, ...], params: dict) -> list[str]:
    objs = []
    for o in raw_objects:
        if o.endswith("off_*"):
            if "gtin" in params:
                objs.append(f"clearshelf_off.off_{params['gtin']}")
            else:
                objs.append(o)
        else:
            objs.append(o)
    return objs


def cache_state(raw_objects: tuple[str, ...], params: dict, storage: dict | None) -> tuple[str, dict, dict]:
    """(state, per-object detail, source_cached_at). state is hit, miss, unknown,
    or uncached for a template that reads only the ops tables (never cached by design)."""
    objs = resolve(raw_objects, params)
    cacheable = [o for o in objs if not o.startswith("clearshelf_ops.")]
    if not objs:
        return "unknown", {}, {}
    if not cacheable:
        return "uncached", {o: "uncached_by_design" for o in objs}, {}
    if storage is None:
        return "unknown", {o: "spark_ui_unreachable" for o in objs}, {}
    detail: dict[str, str] = {}
    for o in objs:
        if o.startswith("clearshelf_ops."):
            detail[o] = "uncached_by_design"
        elif o.endswith("off_*"):
            detail[o] = "hit" if any(c.startswith("clearshelf_off.off_") for c in storage["cached"]) else "miss"
        else:
            detail[o] = "hit" if o.lower() in storage["cached"] else "miss"
    states = [detail[o] for o in cacheable]
    state = "hit" if all(s == "hit" for s in states) else "miss"
    events = last_cache_events(storage.get("started_at_ms"))
    cached_at = {o: events[o.lower()] for o in cacheable if o.lower() in events}
    return state, detail, cached_at


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
