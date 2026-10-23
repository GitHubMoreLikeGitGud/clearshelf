"""JDBC access to Zetaris Lightning for the ClearShelf gateway.

Adapted from `scripts/zetaris_sql.py` in the Zetaris getting-started repository
(https://github.com/zetaris/getting-started, commit 6a2fbaa, Apache License 2.0):
the `.env.local` loader, the SQL statement splitter and the JayDeBeApi channel.
Modified for ClearShelf: Windows JDK discovery, column names and timing in
results, a bounded wait with statement cancel, and one lock per connection.
Secrets are read from the environment and never printed.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE_NAME = ".env.local"
DEFAULT_JDBC_URL = "jdbc:zetaris:lightning@localhost:10000"
DRIVER_CLASS = "com.zetaris.lightning.jdbc.LightningDriver"
UA_PLACEHOLDER = "YOUR_APP_NAME YOUR_CONTACT_EMAIL"


class ZetarisError(RuntimeError):
    pass


class QueryTimeout(ZetarisError):
    pass


# --- environment -----------------------------------------------------------


def load_env(env_file: str | os.PathLike | None = None) -> Path | None:
    """Load `.env.local` from the repo root into os.environ without overriding
    variables that are already set. Returns the file used, or None."""
    path = Path(env_file) if env_file else ROOT / ENV_FILE_NAME
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)
    return path


def require(*names: str) -> None:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise ZetarisError("Missing in the environment or .env.local: " + ", ".join(missing))


def user_agent() -> str:
    """The User-Agent sent to source APIs, from CLEARSHELF_USER_AGENT."""
    ua = os.environ.get("CLEARSHELF_USER_AGENT", "").strip()
    if not ua or "<" in ua or ">" in ua:
        raise ZetarisError("Set CLEARSHELF_USER_AGENT in .env.local (an app name, plus a contact once the owner supplies one).")
    if '"' in ua or "'" in ua:
        raise ZetarisError("CLEARSHELF_USER_AGENT must not contain quotes.")
    return ua


def apply_user_agent(sql: str) -> str:
    return sql.replace(UA_PLACEHOLDER, user_agent()) if UA_PLACEHOLDER in sql else sql


# --- SQL splitting ---------------------------------------------------------


def split_statements(text: str) -> list[str]:
    """Split SQL on semicolons outside quotes, dropping comments.

    Handles '..', "..", `..` quoting and both `-- line` and `/* block */`
    comments. A CREATE TABLE that follows COMPILE USL ... DDL is merged back
    into that statement, because a multi-table USL must be sent whole.
    """
    statements: list[str] = []
    buf: list[str] = []
    i, n, quote = 0, len(text), None
    while i < n:
        c = text[i]
        if quote:
            buf.append(c)
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
            buf.append(c)
        elif text.startswith("--", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        elif c == ";":
            _push(statements, "".join(buf))
            buf = []
        else:
            buf.append(c)
        i += 1
    _push(statements, "".join(buf))
    return statements


def _push(statements: list[str], raw: str) -> None:
    stmt = raw.strip()
    if not stmt:
        return
    if stmt.upper().startswith("CREATE TABLE") and statements and statements[-1].upper().startswith("COMPILE USL"):
        statements[-1] += ";\n" + stmt
    else:
        statements.append(stmt)


# --- JDK -------------------------------------------------------------------


def find_java_home() -> str | None:
    """A JDK home with bin/java(.exe): JAVA_HOME first, then common install roots."""
    candidates: list[Path] = []
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]))
    for root in (r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\Java", r"C:\Program Files\Microsoft"):
        base = Path(root)
        if base.is_dir():
            candidates.extend(sorted((p for p in base.iterdir() if p.is_dir()), reverse=True))
    candidates.extend(Path(p) for p in ("/usr/lib/jvm/default-java", "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"))
    for home in candidates:
        if (home / "bin" / "java.exe").is_file() or (home / "bin" / "java").is_file():
            return str(home)
    return None


# --- connection ------------------------------------------------------------


@dataclass
class QueryResult:
    sql: str
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    elapsed_ms: int = 0
    executed_at: str = ""


def _plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _short(text: str, n: int = 600) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n] + "..."


class LightningConnection:
    """One persistent JDBC connection, used by one caller at a time."""

    def __init__(self, username: str, password: str, jar: str | None = None, url: str | None = None, name: str = "admin") -> None:
        self.name = name
        self._user = username
        self._password = password
        self.jar = jar or os.environ.get("ZETARIS_JDBC_JAR", "")
        self.url = url or os.environ.get("ZETARIS_JDBC_URL", DEFAULT_JDBC_URL)
        self.lock = threading.RLock()
        self._conn = None
        self.connected_at: float | None = None
        self.connect_count = 0

    @classmethod
    def from_env(cls, role: str = "admin") -> "LightningConnection":
        prefix = "ZETARIS_ADMIN" if role == "admin" else "ZETARIS_READER"
        require(f"{prefix}_USERNAME", f"{prefix}_PASSWORD", "ZETARIS_JDBC_JAR")
        return cls(os.environ[f"{prefix}_USERNAME"], os.environ[f"{prefix}_PASSWORD"], name=role)

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def connect(self) -> None:
        if not Path(self.jar).is_file():
            raise ZetarisError(f"Driver JAR not found: {self.jar}")
        home = find_java_home()
        if not home:
            raise ZetarisError("No JDK found. Install JDK 11+ and set JAVA_HOME.")
        os.environ["JAVA_HOME"] = home
        import jaydebeapi

        try:
            self._conn = jaydebeapi.connect(DRIVER_CLASS, self.url, [self._user, self._password], self.jar)
        except Exception as e:  # jaydebeapi raises Java exceptions
            self._conn = None
            raise ZetarisError(f"connect failed: {_short(e)}") from e
        self.connected_at = time.time()
        self.connect_count += 1

    def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def execute(self, sql: str, timeout_s: float | None = None, max_rows: int | None = None) -> QueryResult:
        """Run one statement and fetch its rows. With timeout_s, wait at most
        that long, then cancel the statement, drop the connection and raise
        QueryTimeout (the server may still be working on it)."""
        with self.lock:
            if self._conn is None:
                self.connect()
            started = time.time()
            box: dict[str, Any] = {}
            cur = self._conn.cursor()
            # A plain java.sql.Statement, not JayDeBeApi's PreparedStatement:
            # the driver reads a `?` inside a REST endpoint URL as a bind parameter.
            stmt = self._conn.jconn.createStatement()
            cur._prep = stmt

            def work() -> None:
                try:
                    if stmt.execute(sql):
                        cur._rs = stmt.getResultSet()
                        cur._meta = cur._rs.getMetaData()
                    if cur.description is None:
                        box["columns"], box["rows"] = [], []
                        return
                    box["columns"] = [d[0] for d in cur.description]
                    rows = cur.fetchall() if max_rows is None else cur.fetchmany(max_rows)
                    box["rows"] = [[_plain(v) for v in r] for r in rows]
                except Exception as e:
                    box["error"] = e

            if timeout_s is None:
                work()
            else:
                t = threading.Thread(target=work, daemon=True)
                t.start()
                t.join(timeout_s)
                if t.is_alive():
                    try:
                        prep = getattr(cur, "_prep", None)
                        if prep is not None:
                            prep.cancel()
                    except Exception:
                        pass
                    self.close()
                    raise QueryTimeout(f"no result within {timeout_s:.0f} s; statement cancel sent, connection dropped")
            try:
                cur.close()
            except Exception:
                pass
            elapsed = int((time.time() - started) * 1000)
            if "error" in box:
                raise ZetarisError(_short(box["error"]))
            rows = box.get("rows", [])
            return QueryResult(
                sql=sql,
                columns=box.get("columns", []),
                rows=rows,
                row_count=len(rows),
                elapsed_ms=elapsed,
                executed_at=time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(started)),
            )
