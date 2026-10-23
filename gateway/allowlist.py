"""Statement allowlist for the gateway's Zetaris connections.

Roles, each a superset of the one before:
- reader:    SELECT, SHOW, DESCRIBE, LOAD USL, LIST DQ, RUN DQ, SHOW DQ
- registrar: + CREATE LIGHTNING REST TABLE (allowlisted hosts, CLEARSHELF_* databases),
               CACHE / UNCACHE TABLE clearshelf_*, ACTIVATE USL TABLE lightning.metastore.clearshelf.*
- onboard:   + COMPILE USL, UPDATE USL ... DESCRIPTION, REGISTER DQ, REMOVE USL clearance_usl,
               CREATE LIGHTNING DATABASE CLEARSHELF_*, CREATE SCHEMASTORE CONTAINER clearshelf,
               CREATE NAMESPACE lightning.metastore[.clearshelf]

Always refused: DROP, GRANT, REVOKE, INVALIDATE CACHE, OFFSITE*, port 8889,
more than one statement, and a trailing semicolon. The one multi-part statement
is COMPILE USL, and every part after its DDL keyword must be a CREATE TABLE.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

ROLES = ("reader", "registrar", "onboard")
REST_HOSTS = {
    "world.openfoodfacts.org": "https",
    "api.fda.gov": "https",
    "data.food.gov.uk": "https",
    "clearshelf-ops": "http",
}
NAMESPACE = "lightning.metastore.clearshelf"
USL = NAMESPACE + ".clearance_usl"

_ID = r"[A-Za-z_][A-Za-z0-9_]*"
_ALWAYS_REFUSED = re.compile(r"^\s*(DROP|GRANT|REVOKE|INVALIDATE\s+CACHE|OFFSITE)\b", re.I)
_READER = re.compile(r"^\s*(SELECT|SHOW|DESCRIBE|LOAD\s+USL|LIST\s+DQ|RUN\s+DQ)\b", re.I)
_COMPILE_HEAD = re.compile(
    rf"^\s*COMPILE\s+USL\s+(IF\s+NOT\s+EXISTS\s+)?clearance_usl\s+DEPLOY\s+NAMESPACE\s+{re.escape(NAMESPACE)}\s+DDL\s+", re.I)
_COMPILE_PART = re.compile(rf"^\s*CREATE\s+TABLE\s+{_ID}\s*\(", re.I)
_COMPILE_WRITE = re.compile(r"\b(DROP|GRANT|REVOKE|TRUNCATE|ALTER|INSERT|DELETE|UPDATE|MERGE|REMOVE|OFFSITE)\b", re.I)


class Refused(ValueError):
    pass


def _strip_literals(sql: str) -> str:
    """The statement with quoted text blanked, for structural checks."""
    out, quote = [], None
    for c in sql:
        if quote:
            if c == quote:
                quote = None
                out.append(c)
            else:
                out.append(" ")
        elif c in "'\"`":
            quote = c
            out.append(c)
        else:
            out.append(c)
    return "".join(out)


def _check_compile(bare: str) -> None:
    """COMPILE USL clearance_usl ... DDL CREATE TABLE ...; CREATE TABLE ...
    `bare` has literals blanked, so semicolons inside quotes do not split."""
    head = _COMPILE_HEAD.match(bare)
    if not head:
        raise Refused("COMPILE USL only for clearance_usl in the clearshelf namespace")
    for part in bare[head.end():].split(";"):
        if not _COMPILE_PART.match(part):
            raise Refused("every COMPILE USL part must be a CREATE TABLE: " + " ".join(part.split())[:60])
    if _COMPILE_WRITE.search(bare):
        raise Refused("write keyword inside COMPILE USL")


def _registrar_ok(sql: str, bare: str) -> bool:
    m = re.match(rf"^\s*CREATE\s+LIGHTNING\s+REST\s+TABLE\s+{_ID}\s+FROM\s+(CLEARSHELF_[A-Z]+)\s+REQUEST\s*\(", sql, re.I)
    if m:
        endpoints = re.findall(r"endpoint\s+[\"']([^\"']+)[\"']", sql, re.I)
        if len(endpoints) != 1:
            raise Refused("a REST table needs exactly one endpoint")
        u = urlsplit(endpoints[0])
        if REST_HOSTS.get(u.hostname or "") != u.scheme or u.port not in (None,):
            raise Refused(f"endpoint host not allowlisted: {u.scheme}://{u.netloc}")
        if re.search(r"\bAUTH\s+BY\b", bare, re.I):
            raise Refused("AUTH BY is not used by ClearShelf")
        return True
    if re.match(rf"^\s*(CACHE|UNCACHE)\s+TABLE\s+(IF\s+EXISTS\s+)?clearshelf_[a-z]+\.{_ID}\s*$", sql, re.I):
        return True
    if re.match(rf"^\s*ACTIVATE\s+USL\s+TABLE\s+{re.escape(USL)}\.{_ID}\s+AS\s+SELECT\b", sql, re.I):
        return True
    return False


def _onboard_ok(sql: str) -> bool:
    patterns = [
        rf"^\s*COMPILE\s+USL\s+(IF\s+NOT\s+EXISTS\s+)?clearance_usl\s+DEPLOY\s+NAMESPACE\s+{re.escape(NAMESPACE)}\s+DDL\s",
        rf"^\s*UPDATE\s+USL\s+{re.escape(USL)}(\.{_ID}){{0,2}}\s+SET\s+((TABLE|COLUMN)\s+)?DESCRIPTION\s",
        rf"^\s*REGISTER\s+DQ\s+{_ID}\s+TABLE\s+{re.escape(USL)}\.{_ID}\s+AS\s",
        rf"^\s*REMOVE\s+USL\s+clearance_usl\s+NAMESPACE\s+{re.escape(NAMESPACE)}\s*$",
        r"^\s*CREATE\s+LIGHTNING\s+DATABASE\s+CLEARSHELF_[A-Z]+\s+DESCRIBE\s+BY\s",
        r"^\s*CREATE\s+SCHEMASTORE\s+CONTAINER\s+clearshelf\s*$",
        r"^\s*CREATE\s+NAMESPACE\s+IF\s+NOT\s+EXISTS\s+lightning\.metastore(\.clearshelf)?\s*$",
    ]
    return any(re.match(p, sql, re.I) for p in patterns)


def check(sql: str, role: str) -> str:
    """Return the statement kind if `role` may run `sql`, else raise Refused."""
    if role not in ROLES:
        raise Refused(f"unknown role: {role}")
    if not sql or not sql.strip():
        raise Refused("empty statement")
    bare = _strip_literals(sql)
    if "8889" in sql:
        raise Refused("port 8889 is never called")
    if bare.rstrip().endswith(";"):
        raise Refused("no trailing semicolon")
    is_compile = re.match(r"^\s*COMPILE\s+USL\b", sql, re.I) is not None
    if ";" in bare and not is_compile:
        raise Refused("one statement per call")
    if is_compile:
        _check_compile(bare)
    if _ALWAYS_REFUSED.match(sql):
        raise Refused("statement kind is always refused")
    if _READER.match(sql):
        if re.match(r"^\s*SELECT\b", sql, re.I) and re.search(r"\b(INSERT|DROP|GRANT|REVOKE|TRUNCATE|ALTER)\b", bare, re.I):
            raise Refused("write keyword inside a SELECT")
        return "read"
    if role in ("registrar", "onboard") and _registrar_ok(sql, bare):
        return "register"
    if role == "onboard" and _onboard_ok(sql):
        return "onboard"
    raise Refused(f"not allowed for role {role}: {' '.join(sql.split())[:80]}")
