"""Append-only log of every statement the gateway sends (data/evidence/sql_log.jsonl)."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

from .jdbc import ROOT

LOG_PATH = ROOT / "data" / "evidence" / "sql_log.jsonl"
_lock = threading.Lock()


def sha256(sql: str) -> str:
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()


def log_statement(entry: dict, path: Path | None = None) -> None:
    path = path or LOG_PATH
    record = {"logged_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **entry}
    if "sql" in record and "sql_sha256" not in record:
        record["sql_sha256"] = sha256(record["sql"])
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
