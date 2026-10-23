"""Full onboarding of ClearShelf into Zetaris (SPEC section 3).

    .venv/Scripts/python -m gateway.onboard --dry-run --skip-exists
    .venv/Scripts/python -m gateway.onboard --skip-exists

Phases, in order (`--phases` picks a subset):
  base      Lightning databases, SchemaStore container, USL namespace (00)
  feeds     openFDA and FSA REST tables, cached (01, 02)
  ops       ops REST tables over http://clearshelf-ops (03); a missing ops file is seeded first
  off       one OFF REST table per manifest SKU: CREATE, DESCRIBE, CACHE (04, generated)
  usl       COMPILE USL clearance_usl and its descriptions (10)
  links     data/ops/recall_links.json from the manifest's measured recall links
  activate  all nine activations after a compile, otherwise product, declared_allergen
            and recall_product_link (11, generated)
  dq        REGISTER DQ for missing custom rules (12), then RUN DQ and SHOW DQ INVALID
  report    row counts and the recall join, written to zetaris/README.md

Existence is checked first with SHOW / LIST statements and the Spark UI (no source
calls). Without --skip-exists an existing object stops the run before anything is
sent; with it, existing objects are skipped and cached tables are not re-cached.
Statements that call Open Food Facts (CREATE, CACHE) are at least --off-gap seconds
apart (default 5, never below 2.5) and are retried twice on failure. DESCRIBE and
reads of cached tables make no source call. Every statement passes the onboard
allowlist and is logged to data/evidence/sql_log.jsonl.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.request import urlopen

from . import allowlist, cache, sqlgen
from . import manifest as manifest_mod
from .jdbc import ROOT, LightningConnection, QueryResult, QueryTimeout, ZetarisError, apply_user_agent, load_env, split_statements
from .sqllog import log_statement, sha256

PHASES = ("base", "feeds", "ops", "off", "usl", "links", "activate", "dq", "report")
SQL_DIR = ROOT / "zetaris" / "sql"
MANIFEST = ROOT / "data" / "manifest" / "skus.json"
REFERENCE = ROOT / "data" / "reference" / "market_allergens.json"
OPS_DIR = ROOT / "data" / "ops"
EVIDENCE_DIR = ROOT / "data" / "evidence"
DESCRIBE_FILE = ROOT / "zetaris" / "off_describe.json"
README = ROOT / "zetaris" / "README.md"
OPS_DEBUG_URL = os.environ.get("CLEARSHELF_OPS_DEBUG_URL", "http://127.0.0.1:8792")
USL = sqlgen.USL
NS = allowlist.NAMESPACE

OFF_GAP_S = 5.0
OFF_GAP_FLOOR_S = 2.5
OFF_RETRIES = 2
TIMEOUTS = {"show": 30.0, "describe": 60.0, "create": 120.0, "cache": 300.0, "activate": 600.0,
            "compile": 600.0, "dq": 120.0, "select": 300.0, "ddl": 120.0}
ALREADY_EXISTS = re.compile(r"already exist", re.I)
FEEDS = (("clearshelf_fda", "enforcement_undeclared", "01_fda_enforcement_create.sql"),
         ("clearshelf_fsa", "allergy_alerts", "02_fsa_allergy_alerts_create.sql"))
OPS_TABLES = ("health", "market_allergens", "decisions", "recall_links", "extractions")
DQ_RUNS = (("has_ingredients", "product"), ("english_label", "product"), ("market_code", "declared_allergen"),
           ("gtin", "declared_allergen"), ("known_relation", "extracted_allergen"), ("market_code", "extracted_allergen"),
           ("gtin", "recall_product_link"), ("recall_number", "recall_product_link"))
DQ_INVALID = (("has_ingredients", "product"), ("english_label", "product"), ("market_code", "declared_allergen"),
              ("gtin", "recall_product_link"), ("recall_number", "recall_product_link"))
DQ_EQUIVALENT = {
    "has_ingredients": f"SELECT gtin FROM {USL}.product WHERE NOT (ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0) ORDER BY gtin",
    "english_label": f"SELECT gtin FROM {USL}.product WHERE NOT (lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0)) ORDER BY gtin",
    "market_code": f"SELECT d.gtin, d.market_code FROM {USL}.declared_allergen d LEFT JOIN {USL}.market_allergen m ON d.market_code = m.market_code WHERE m.market_code IS NULL ORDER BY d.gtin, d.market_code",
}
RECALL_JOIN = (
    f"SELECT p.gtin, p.product_name, p.vegan_claim, f.recall_number, f.report_date, f.classification, f.status AS recall_status, "
    f"substr(f.reason, 1, 120) AS reason FROM {USL}.product p JOIN {USL}.recall_product_link l ON p.gtin = l.gtin "
    f"JOIN {USL}.fda_recall f ON l.recall_number = f.recall_number ORDER BY p.gtin, f.recall_number"
)
JOIN_MAP = (f"SELECT l.transform, COUNT(*) AS links, COUNT(p.gtin) AS in_catalogue FROM {USL}.recall_product_link l "
            f"LEFT JOIN {USL}.product p ON l.gtin = p.gtin GROUP BY l.transform ORDER BY l.transform")
DECLARED_JOIN = (f"SELECT m.market, d.relation, COUNT(*) AS n FROM {USL}.declared_allergen d JOIN {USL}.market_allergen m "
                 f"ON d.market_code = m.market_code GROUP BY m.market, d.relation ORDER BY m.market, d.relation")
README_START, README_END = "<!-- onboard:counts:start -->", "<!-- onboard:counts:end -->"
INVALID_KEY_COLUMNS = {"gtin", "market_code", "declared_key", "link_key", "recall_number", "relation"}


def usl_counts_sql() -> str:
    return " UNION ALL ".join(f"SELECT '{t}' AS usl_table, COUNT(*) AS n FROM {USL}.{t}" for t in sqlgen.ACTIVATION_ORDER)


class OnboardError(RuntimeError):
    pass


@dataclass
class State:
    """What already exists in Zetaris, from SHOW / LIST and the Spark UI."""
    probed: bool = False
    databases: set[str] = field(default_factory=set)
    tables: dict[str, set[str]] = field(default_factory=dict)  # db (lower) -> table names (lower)
    namespaces: set[str] = field(default_factory=set)  # under lightning.metastore
    usl_exists: bool = False
    dq_rules: set[tuple[str, str]] = field(default_factory=set)  # (rule, table)
    cached: set[str] = field(default_factory=set)
    app_id: str | None = None

    def has_table(self, db: str, table: str) -> bool:
        return table.lower() in self.tables.get(db.lower(), set())


@dataclass
class Args:
    dry_run: bool = False
    skip_exists: bool = False
    offline: bool = False
    phases: tuple[str, ...] = PHASES
    roles: tuple[str, ...] = manifest_mod.CATALOGUE_ROLES
    gtins: tuple[str, ...] = ()
    off_gap_s: float = OFF_GAP_S
    activate_all: bool = False
    write_files: bool = True


class Onboarder:
    def __init__(self, conn: LightningConnection | None, args: Args,
                 storage: Callable[[], dict | None] = cache.spark_storage,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time,
                 out: Callable[[dict], None] | None = None) -> None:
        self.conn = conn
        self.args = args
        self._storage = storage
        self._sleep = sleep
        self._clock = clock
        self._out = out or (lambda rec: print(json.dumps(rec, ensure_ascii=False, default=str), flush=True))
        self.state = State()
        self.last_off_call = 0.0
        self.compiled = False
        self.fields: dict[str, set[str]] = {}
        self.summary: dict = {"started_at": cache.now_iso(), "dry_run": args.dry_run, "phases": list(args.phases),
                              "statements": 0, "skipped": [], "errors": []}
        self.skus = manifest_mod.select(manifest_mod.load(MANIFEST), args.roles)
        self.targets = manifest_mod.select(self.skus, args.roles, args.gtins)
        if args.gtins and len(self.targets) != len(set(args.gtins)):
            missing = sorted(set(args.gtins) - {s.gtin for s in self.targets})
            raise OnboardError(f"not in the manifest (for roles {args.roles}): {missing}")

    # -- statement execution --------------------------------------------------

    def emit(self, **rec) -> None:
        self._out(rec)

    def _log(self, entry: dict) -> None:
        log_statement({"source_file": "gateway.onboard", "role": "onboard", **entry})

    def probe(self, sql: str) -> QueryResult | None:
        """A read-only existence check; runs in dry-run too (not with --offline)."""
        allowlist.check(sql, "reader")
        if self.args.offline or self.conn is None:
            return None
        entry = {"phase": "probe", "sql": sql, "timeout_s": TIMEOUTS["show"]}
        try:
            res = self.conn.execute(sql, timeout_s=TIMEOUTS["show"])
        except ZetarisError as e:
            self._log({**entry, "error": str(e)})
            return None
        self._log({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count, "executed_at": res.executed_at, "error": None})
        return res

    def run(self, sql: str, phase: str, kind: str, *, off_call: bool = False, note: str = "", head: bool | None = None) -> QueryResult | None:
        """Send one statement (or, in dry-run, print it). Raises ZetarisError.
        `head` logs the first result rows (default for DQ runs and SELECTs)."""
        timeout = TIMEOUTS[kind]
        wire = sql if self.args.dry_run else apply_user_agent(sql)
        allowlist.check(wire, "onboard")
        self.summary["statements"] += 1
        if self.args.dry_run:
            gap = f", OFF call spaced >= {self.gap():g} s" if off_call else ""
            self.emit(phase=phase, plan=" ".join(sql.split())[:240] + ("..." if len(sql) > 240 else ""),
                      timeout_s=timeout, note=(note + gap).strip(", "))
            return None
        spaced = 0.0
        if off_call:
            spaced = self.gap() - (self._clock() - self.last_off_call)
            if spaced > 0:
                self._sleep(spaced)
        entry = {"phase": phase, "sql": sql, "sql_sha256": sha256(sql), "timeout_s": timeout}
        if spaced > 0:
            entry["spaced_s"] = round(spaced, 2)
        try:
            res = self.conn.execute(wire, timeout_s=timeout)
        except ZetarisError as e:
            entry.update(error=str(e), timeout=isinstance(e, QueryTimeout))
            self._log(entry)
            raise
        finally:
            if off_call:
                self.last_off_call = self._clock()
        entry.update(elapsed_ms=res.elapsed_ms, row_count=res.row_count, executed_at=res.executed_at, error=None)
        log_head = head if head is not None else kind in ("dq", "select")
        if log_head:
            entry.update(columns=res.columns, result_head=[[v if not isinstance(v, str) or len(v) <= 200 else v[:200] + "..."
                                                            for v in r] for r in res.rows[:5]])
        self._log(entry)
        self.emit(phase=phase, ok=True, elapsed_ms=res.elapsed_ms, row_count=res.row_count,
                  sql=" ".join(sql.split())[:160], note=note or None)
        return res

    def gap(self) -> float:
        return max(self.args.off_gap_s, OFF_GAP_FLOOR_S)

    def off_call(self, sql: str, phase: str, kind: str, done: Callable[[], bool], note: str) -> QueryResult | None:
        """An Open Food Facts call with up to OFF_RETRIES retries. Before each retry
        `done()` re-checks (without a source call) whether the last attempt took effect."""
        for attempt in range(OFF_RETRIES + 1):
            try:
                return self.run(sql, phase, kind, off_call=True, note=note + (f" retry {attempt}" if attempt else ""))
            except ZetarisError as e:
                if ALREADY_EXISTS.search(str(e)) and self.args.skip_exists:
                    self.skip(phase, note, "already exists (reported by Zetaris)")
                    return None
                self.emit(phase=phase, ok=False, error=str(e)[:300], note=f"{note} attempt {attempt + 1}")
                if attempt == OFF_RETRIES:
                    raise
                self._sleep(max(self.gap(), 5.0 * (attempt + 1)))
                if done():
                    self.emit(phase=phase, note=f"{note}: took effect despite the error")
                    return None
        return None

    def skip(self, phase: str, what: str, why: str) -> None:
        self.summary["skipped"].append(f"{phase}: {what}: {why}")
        self.emit(phase=phase, skip=what, why=why)

    # -- existence ----------------------------------------------------------

    def refresh_state(self) -> None:
        st = State()
        res = self.probe("SHOW LIGHTNING DATABASES")
        if res is not None:
            st.probed = True
            st.databases = {str(r[0]).upper() for r in res.rows if r}
            for db in ("clearshelf_off", "clearshelf_fda", "clearshelf_fsa", "clearshelf_ops"):
                if db.upper() in st.databases:
                    t = self.probe(f"SHOW TABLES IN {db}")
                    st.tables[db] = {str(r[0]).split(".")[-1].lower() for r in (t.rows if t else []) if r}
            ns = self.probe("SHOW NAMESPACES OR TABLES IN lightning.metastore")
            st.namespaces = {str(r[0]).lower() for r in (ns.rows if ns else []) if r}
            if "clearshelf" in st.namespaces:
                u = self.probe(f"SHOW NAMESPACES OR TABLES IN {NS}")
                st.usl_exists = any(r and str(r[0]).lower() == "clearance_usl" for r in (u.rows if u else []))
            if st.usl_exists:
                d = self.probe(f"LIST DQ USL {USL}")
                st.dq_rules = {(str(r[0]), str(r[1])) for r in (d.rows if d else []) if len(r) >= 2}
        storage = None if self.args.offline else self._storage()
        if storage:
            st.cached, st.app_id = set(storage["cached"]), storage["app_id"]
        self.state = st

    def existing_objects(self) -> list[str]:
        """Objects this run would create that already exist (for the no --skip-exists stop)."""
        st, out = self.state, []
        if "base" in self.args.phases:
            out += [f"database {d}" for d in ("CLEARSHELF_OFF", "CLEARSHELF_FDA", "CLEARSHELF_FSA", "CLEARSHELF_OPS") if d in st.databases]
        if "feeds" in self.args.phases:
            out += [f"{db}.{t}" for db, t, _ in FEEDS if st.has_table(db, t)]
        if "ops" in self.args.phases:
            out += [f"clearshelf_ops.{t}" for t in OPS_TABLES if st.has_table("clearshelf_ops", t)]
        if "off" in self.args.phases:
            out += [sqlgen.off_table(s.gtin) for s in self.targets if st.has_table("clearshelf_off", f"off_{s.gtin}")]
        if "usl" in self.args.phases and st.usl_exists:
            out.append(USL)
        return out

    # -- phases -------------------------------------------------------------

    def statements(self, name: str) -> list[str]:
        return split_statements((SQL_DIR / name).read_text(encoding="utf-8"))

    def phase_base(self) -> None:
        st = self.state
        all_dbs = all(d in st.databases for d in ("CLEARSHELF_OFF", "CLEARSHELF_FDA", "CLEARSHELF_FSA", "CLEARSHELF_OPS"))
        for s in self.statements("00_clearshelf_base_create.sql"):
            m = re.match(r"^\s*CREATE\s+LIGHTNING\s+DATABASE\s+(\w+)", s, re.I)
            if m and m.group(1).upper() in st.databases:
                self.skip("base", m.group(1), "database exists")
                continue
            if re.match(r"^\s*CREATE\s+SCHEMASTORE\s+CONTAINER\b", s, re.I) and all_dbs and "clearshelf" in st.namespaces:
                self.skip("base", "schemastore container clearshelf", "created with the databases and namespace (no list command)")
                continue
            if re.match(r"^\s*CREATE\s+NAMESPACE\s+IF\s+NOT\s+EXISTS\s+lightning\.metastore\.clearshelf\s*$", s, re.I) and "clearshelf" in st.namespaces:
                self.skip("base", NS, "namespace exists")
                continue
            if re.match(r"^\s*CREATE\s+NAMESPACE\s+IF\s+NOT\s+EXISTS\s+lightning\.metastore\s*$", s, re.I) and st.namespaces:
                self.skip("base", "lightning.metastore", "namespace exists")
                continue
            self._run_tolerant(s, "base", "ddl")

    def _run_tolerant(self, sql: str, phase: str, kind: str, note: str = "") -> QueryResult | None:
        try:
            return self.run(sql, phase, kind, note=note)
        except ZetarisError as e:
            if self.args.skip_exists and ALREADY_EXISTS.search(str(e)):
                self.skip(phase, " ".join(sql.split())[:60], "already exists (reported by Zetaris)")
                return None
            raise

    def phase_feeds(self) -> None:
        for db, table, script in FEEDS:
            obj = f"{db}.{table}"
            stmts = self.statements(script)
            create = next(s for s in stmts if re.match(r"^\s*CREATE\s+LIGHTNING\s+REST\s+TABLE\b", s, re.I))
            if self.state.has_table(db, table):
                self.skip("feeds", obj, "table exists")
            else:
                self._run_tolerant(create, "feeds", "create", note=obj)
            if obj in self.state.cached:
                self.skip("feeds", f"CACHE {obj}", "already cached in the driver")
            else:
                self.run(f"CACHE TABLE {obj}", "feeds", "cache", note=obj)

    def phase_ops(self) -> None:
        self.seed_ops_files()
        for s in self.statements("03_ops_create.sql"):
            m = re.match(r"^\s*CREATE\s+LIGHTNING\s+REST\s+TABLE\s+(\w+)\s+FROM\s+CLEARSHELF_OPS\b", s, re.I)
            if not m:
                continue
            if self.state.has_table("clearshelf_ops", m.group(1)):
                self.skip("ops", f"clearshelf_ops.{m.group(1)}", "table exists")
            else:
                self._run_tolerant(s, "ops", "create", note=f"clearshelf_ops.{m.group(1)}")

    def phase_off(self) -> None:
        st = self.state
        for i, s in enumerate(self.targets, 1):
            table = sqlgen.off_table(s.gtin)
            note = f"{i}/{len(self.targets)} {s.gtin}"
            if st.has_table("clearshelf_off", f"off_{s.gtin}"):
                self.skip("off", table, "table exists")
            else:
                self.off_call(sqlgen.create_off_table(s.gtin), "off", "create", note=note + " CREATE",
                              done=lambda g=s.gtin: self._off_registered(g))
            self.describe(s.gtin)
            if table in self.state.cached:
                self.skip("off", f"CACHE {table}", "already cached in the driver")
            else:
                self.off_call(f"CACHE TABLE {table}", "off", "cache", note=note + " CACHE",
                              done=lambda t=table: self._is_cached(t))
                if not self.args.dry_run:
                    self._mark_cached(table)

    def _off_registered(self, gtin: str) -> bool:
        res = self.probe("SHOW TABLES IN clearshelf_off")
        names = {str(r[0]).split(".")[-1].lower() for r in (res.rows if res else []) if r}
        return f"off_{gtin}" in names

    def _is_cached(self, table: str) -> bool:
        storage = self._storage()
        return bool(storage and table in storage["cached"])

    def _mark_cached(self, table: str) -> None:
        if self._is_cached(table):
            self.state.cached.add(table)
        else:
            self.summary["errors"].append(f"{table}: CACHE returned but the Spark UI does not list it")

    def describe(self, gtin: str) -> set[str] | None:
        """Fields of the product struct, from DESCRIBE (no source call). In a dry
        run: the recorded fields, or every requested field for a new table."""
        if gtin in self.fields:
            return self.fields[gtin]
        if self.args.dry_run:
            recorded = load_describe().get(gtin)
            self.fields[gtin] = set(recorded) if recorded is not None else set(sqlgen.OFF_FIELDS.split(","))
            return self.fields[gtin]
        res = self.run(f"DESCRIBE {sqlgen.off_table(gtin)}", "off", "describe", note=gtin)
        cols = {str(r[0]) for r in res.rows if r}
        if "product" not in cols:
            self.summary["errors"].append(f"{gtin}: DESCRIBE shows no product struct (columns {sorted(cols)})")
            return None
        self.fields[gtin] = sqlgen.product_fields_from_describe(res.rows)
        return self.fields[gtin]

    def phase_usl(self) -> None:
        if self.state.usl_exists:
            self.skip("usl", USL, "USL exists (compiled; descriptions kept)")
            return
        for s in self.statements("10_clearance_usl_create.sql"):
            self.run(s, "usl", "compile" if s.upper().startswith("COMPILE") else "ddl")
        self.compiled = True

    def phase_links(self) -> None:
        rows = manifest_mod.recall_links(self.skus)
        path = OPS_DIR / "recall_links.json"
        doc = read_ops(path) if path.is_file() else {"data": [dict(SENTINELS["recall_links"])]}
        merged, replaced = merge_links(doc["data"], rows)
        self.summary["links"] = {"manifest_links": len(rows), "f_prefixed": sum(1 for r in rows if r["recall_number"].startswith("F-")),
                                 "replaced_seed_rows": replaced, "rows_after": len(merged) - 1}
        if self.args.dry_run:
            self.emit(phase="links", plan=f"write {path.relative_to(ROOT)}", **self.summary["links"])
            return
        write_ops(path, {"data": merged})
        served = ops_served_count("recall_links.json")
        self.summary["links"]["served_rows"] = served
        self.emit(phase="links", ok=True, wrote=str(path.relative_to(ROOT)), **self.summary["links"])

    def activation_skus(self) -> list[sqlgen.Sku]:
        """Every selected manifest SKU whose OFF table is registered, cached and
        has a product struct. A table that is not cached is left out: a query on
        the USL would otherwise call Open Food Facts for it on every read."""
        out = []
        for s in self.skus:
            table = sqlgen.off_table(s.gtin)
            registered = self.state.has_table("clearshelf_off", f"off_{s.gtin}") or s.gtin in self.fields
            if self.args.dry_run:
                if not registered and s not in self.targets:
                    continue
            else:
                if not registered:
                    self.summary["errors"].append(f"{s.gtin}: no OFF table; left out of the activation")
                    continue
                if table not in self.state.cached:
                    self.summary["errors"].append(f"{s.gtin}: OFF table not cached; left out of the activation")
                    continue
            f = self.describe(s.gtin)
            if f is None:
                continue
            out.append(sqlgen.Sku(s.gtin, list(s.markets), f))
        return out

    def phase_activate(self) -> None:
        tables = sqlgen.ACTIVATION_ORDER if (self.compiled or self.args.activate_all) else sqlgen.SKU_TABLES
        skus = self.activation_skus()
        if not skus:
            raise OnboardError("no SKU can be activated")
        self.summary["activated_skus"] = len(skus)
        self.summary["activated_tables"] = list(tables)
        for t in sqlgen.ACTIVATION_ORDER:
            if t in tables:
                self.run(sqlgen.activation(t, skus), "activate", "activate", note=f"{t} ({len(skus)} SKUs)" if t in ("product", "declared_allergen") else t)
        if self.args.write_files and not self.args.gtins:
            self.write_scripts(skus)

    def write_scripts(self, skus: list[sqlgen.Sku]) -> None:
        """Regenerate the committed OFF and activation scripts and the recorded
        DESCRIBE fields from what was activated."""
        names = {s.gtin: s for s in self.skus}
        entries = []
        for s in skus:
            m = names[s.gtin]
            recalls = ", ".join(r.get("recall_number", "") for r in m.recalls)
            entries.append((s.gtin, f"{m.name or s.gtin} ({m.role}{'; FDA ' + recalls if recalls else ''})"))
        files = {
            SQL_DIR / "04_off_products_create.sql": sqlgen.off_create_script(entries),
            SQL_DIR / "04_off_products_select.sql": sqlgen.off_select_script([s.gtin for s in skus]),
            SQL_DIR / "11_clearance_usl_activate_create.sql": sqlgen.activation_script(skus),
        }
        if self.args.dry_run:
            self.emit(phase="activate", plan="regenerate " + ", ".join(str(p.relative_to(ROOT)) for p in files) + f" and {DESCRIBE_FILE.relative_to(ROOT)}")
            return
        for path, text in files.items():
            write_text(path, text)
        recorded = load_describe()
        recorded.update({s.gtin: sorted(s.fields) for s in skus})
        write_text(DESCRIBE_FILE, json.dumps(dict(sorted(recorded.items())), indent=1) + "\n")
        self.emit(phase="activate", ok=True, wrote=[str(p.relative_to(ROOT)) for p in files] + [str(DESCRIBE_FILE.relative_to(ROOT))])

    def phase_dq(self) -> None:
        custom = [s for s in self.statements("12_clearance_dq_create.sql") if s.upper().startswith("REGISTER DQ")]
        for s in custom:
            m = re.match(r"^\s*REGISTER\s+DQ\s+(\w+)\s+TABLE\s+\S+\.(\w+)\s+AS\b", s, re.I)
            if m and (m.group(1), m.group(2)) in self.state.dq_rules:
                self.skip("dq", f"REGISTER DQ {m.group(1)}", "rule exists")
                continue
            self._run_tolerant(s, "dq", "ddl")
        results: dict = {"run": {}, "invalid": {}, "equivalent": {}}
        for rule, table in DQ_RUNS:
            key = f"{rule}@{table}"
            res = self._dq(f"RUN DQ {rule} TABLE {USL}.{table}", key, results["run"], head=True)
            if res is not None:
                row = res.rows[0] if res.rows else []
                results["run"][key] = dict(zip(res.columns, row)) | {"elapsed_ms": res.elapsed_ms}
        for rule, table in DQ_INVALID:
            key = f"{rule}@{table}"
            # Invalid product records carry the whole row, ingredient text included: keep keys only.
            res = self._dq(f"SHOW DQ INVALID RECORD {rule} TABLE {USL}.{table}", key, results["invalid"], head=False)
            if res is not None:
                keep = [i for i, c in enumerate(res.columns) if c in INVALID_KEY_COLUMNS]
                results["invalid"][key] = {"columns": [res.columns[i] for i in keep],
                                           "rows": [[r[i] for i in keep] for r in res.rows], "elapsed_ms": res.elapsed_ms}
        for rule, sql in DQ_EQUIVALENT.items():
            res = self._dq(sql, f"DQ-equivalent SQL {rule}", results["equivalent"], head=True, kind="select")
            if res is not None:
                results["equivalent"][rule] = {"rows": res.rows, "elapsed_ms": res.elapsed_ms}
        self.summary["dq"] = results

    def _dq(self, sql: str, key: str, into: dict, head: bool, kind: str = "dq") -> QueryResult | None:
        """A bounded DQ statement; a timeout or error is recorded, not fatal."""
        try:
            return self.run(sql, "dq", kind, note=key, head=head)
        except ZetarisError as e:
            into[key] = {"timeout" if isinstance(e, QueryTimeout) else "error": str(e)[:300]}
            self.summary["errors"].append(f"dq {key}: {str(e)[:200]}")
            return None

    def phase_report(self) -> None:
        rep: dict = {}
        cached_targets = [s.gtin for s in self.skus if sqlgen.off_table(s.gtin) in self.state.cached]
        if cached_targets:
            res = self.run(sqlgen.off_row_counts(cached_targets), "report", "select", note=f"OFF row counts ({len(cached_targets)} cached tables)")
            if res is not None:
                rep["off_rows"] = {str(r[0]): r[1] for r in res.rows}
        for name, sql in (("usl_counts", usl_counts_sql()), ("join_map", JOIN_MAP), ("recall_join", RECALL_JOIN),
                          ("declared_join", DECLARED_JOIN)):
            res = self.run(sql, "report", "select", note=name)
            if res is not None:
                rep[name] = {"columns": res.columns, "rows": res.rows, "elapsed_ms": res.elapsed_ms}
        self.summary["report"] = rep
        if not self.args.dry_run and self.args.write_files and not self.args.gtins and "usl_counts" in rep:
            write_readme(self.summary)
            self.emit(phase="report", ok=True, wrote=str(README.relative_to(ROOT)))

    # -- driver ---------------------------------------------------------------

    def seed_ops_files(self) -> None:
        """Write a missing ops file (never overwrite one): the sentinel row, plus
        the projected reference for market_allergens and the manifest links."""
        for name in OPS_TABLES:
            path = OPS_DIR / f"{name}.json"
            if path.is_file():
                continue
            rows = [dict(SENTINELS[name])]
            if name == "market_allergens":
                rows += project_reference()
            elif name == "recall_links":
                rows += manifest_mod.recall_links(self.skus)
            elif name == "health":
                rows.append({"name": "clearshelf-ops", "status": "ok", "at": cache.now_iso()})
            if self.args.dry_run:
                self.emit(phase="ops", plan=f"seed missing {path.relative_to(ROOT)} ({len(rows) - 1} rows)")
            else:
                write_ops(path, {"data": rows})
                self.emit(phase="ops", ok=True, wrote=str(path.relative_to(ROOT)), rows=len(rows) - 1)

    def execute(self) -> int:
        self.refresh_state()
        self.summary["state_before"] = {"probed": self.state.probed, "off_tables": len(self.state.tables.get("clearshelf_off", ())),
                                        "cached": len(self.state.cached), "usl_exists": self.state.usl_exists,
                                        "app_id": self.state.app_id}
        self.emit(phase="plan", skus=len(self.skus), targets=len(self.targets), roles=list(self.args.roles),
                  **self.summary["state_before"])
        if not self.args.offline and not self.state.probed:
            raise OnboardError("existence checks failed (Zetaris unreachable?); use --dry-run --offline to plan without it")
        existing = self.existing_objects()
        if existing and not self.args.skip_exists:
            self.emit(phase="plan", ok=False, already_exist=existing[:20], n=len(existing),
                      hint="rerun with --skip-exists; nothing was sent")
            return 2
        for phase in PHASES:
            if phase in self.args.phases:
                getattr(self, f"phase_{phase}")()
                if phase in ("feeds", "ops", "off", "usl") and not self.args.dry_run:
                    self.refresh_state()
        self.summary["finished_at"] = cache.now_iso()
        if not self.args.dry_run:
            out = EVIDENCE_DIR / f"onboard-{time.strftime('%Y%m%dT%H%M%S')}.json"
            write_text(out, json.dumps(self.summary, ensure_ascii=False, indent=1, default=str) + "\n")
            self.emit(phase="done", summary_file=str(out.relative_to(ROOT)), statements=self.summary["statements"],
                      errors=self.summary["errors"])
        else:
            self.emit(phase="done", dry_run=True, statements=self.summary["statements"], skipped=len(self.summary["skipped"]))
        return 1 if self.summary["errors"] else 0


# --- ops files -------------------------------------------------------------------

SENTINELS = {
    "health": {"name": "__schema__", "status": "string", "at": "string"},
    "market_allergens": {"market_code": "__schema__", "market": "string", "allergen": "string", "display_name": "string",
                         "statute": "string", "edition": "string", "citation_url": "string"},
    "decisions": {"decision_id": "__schema__", "gtin": "string", "market": "string", "status": "string", "statement": "string",
                  "decided_at": "string", "decided_date": "string", "actor": "string", "contract_id": "string", "reason": "string"},
    "recall_links": {"link_key": "__schema__", "recall_number": "string", "gtin": "string", "raw_code": "string",
                     "transform": "string", "extracted_by": "string"},
    "extractions": {"extracted_key": "__schema__", "gtin": "string", "market_code": "string", "relation": "string",
                    "evidence_text": "string", "verifier": "string", "run_id": "string"},
}
SUPERSEDED_LINK_SOURCES = {"gate-seed", manifest_mod.LINK_SOURCE}


def project_reference() -> list[dict]:
    """market_allergens rows: the reference's seven USL columns, all strings."""
    ref = json.loads(REFERENCE.read_text(encoding="utf-8"))
    cols = [c for c in SENTINELS["market_allergens"]]
    return [{c: "" if r.get(c) is None else str(r.get(c)) for c in cols} for r in ref["data"]]


def merge_links(existing: list[dict], manifest_rows: list[dict]) -> tuple[list[dict], int]:
    """The sentinel, then links from other writers (the agent's notice extraction)
    unchanged, then the manifest links. Gate-seed and earlier manifest rows are
    replaced. A link another writer already holds keeps that writer's row."""
    sentinel = next((r for r in existing if r.get("link_key") == "__schema__"), dict(SENTINELS["recall_links"]))
    kept = [r for r in existing if r.get("link_key") != "__schema__" and r.get("extracted_by") not in SUPERSEDED_LINK_SOURCES]
    replaced = sum(1 for r in existing if r.get("link_key") != "__schema__" and r.get("extracted_by") in SUPERSEDED_LINK_SOURCES)
    keys = {r.get("link_key") for r in kept}
    for r in kept + manifest_rows:
        if not manifest_mod.RECALL_NUMBER.match(str(r.get("recall_number", ""))):
            raise manifest_mod.ManifestError(f"recall link with a bad recall number: {r}")
    return [sentinel] + kept + [r for r in manifest_rows if r["link_key"] not in keys], replaced


def read_ops(path: Path) -> dict:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
        raise OnboardError(f"{path}: not an ops file with a data array")
    return doc


def write_ops(path: Path, doc: dict) -> None:
    write_text(path, json.dumps(doc, ensure_ascii=False, indent=1) + "\n")


def write_text(path: Path, text: str) -> None:
    """Atomic: a temp file in the same directory, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def ops_served_count(name: str) -> int | None:
    """Rows nginx now serves for an ops file (debug port), or None if unreachable."""
    try:
        with urlopen(f"{OPS_DEBUG_URL}/{name}", timeout=3) as r:
            return len(json.loads(r.read().decode("utf-8"))["data"]) - 1
    except Exception:
        return None


def load_describe() -> dict[str, list[str]]:
    if not DESCRIBE_FILE.is_file():
        return {}
    return json.loads(DESCRIBE_FILE.read_text(encoding="utf-8"))


# --- README -------------------------------------------------------------------

def _fmt(n) -> str:
    return f"{n:,}" if isinstance(n, int) else str(n)


def _stamp() -> str:
    t = cache.now_iso()  # 2026-10-23T10:15:00+0800
    return f"{t[:10]} {t[11:16]} UTC{t[19:22]}:{t[22:24]}"


def readme_section(summary: dict) -> str:
    rep, dq = summary.get("report", {}), summary.get("dq", {})
    counts = {r[0]: r[1] for r in rep.get("usl_counts", {}).get("rows", [])}
    off_rows = rep.get("off_rows", {})
    lines = [README_START, "",
             f"Full onboarding by `gateway/onboard.py`, {_stamp()} "
             f"(Zetaris 2.4.3.1, local Docker): {summary.get('activated_skus', 0)} SKUs from `data/manifest/skus.json`. "
             "Regenerated on every full run.", ""]
    if off_rows:
        ones = sum(1 for v in off_rows.values() if v == 1)
        lines += [f"OFF tables: {len(off_rows)} registered and cached, {ones} of them return exactly 1 row.", ""]
    lines += ["| USL table | Rows |", "|---|---|"]
    lines += [f"| `{t}` | {_fmt(counts.get(t, ''))} |" for t in sqlgen.ACTIVATION_ORDER]
    lines += ["", "| Rule | Table | Total | Valid | Invalid |", "|---|---|---|---|---|"]
    for key, r in dq.get("run", {}).items():
        rule, table = key.split("@")
        if "timeout" in r:
            lines.append(f"| `{rule}` | `{table}` | timed out | | |")
        else:
            lines.append(f"| `{rule}` | `{table}` | {_fmt(r.get('total_record'))} | {_fmt(r.get('valid_record'))} | {_fmt(r.get('invalid_record'))} |")
    jm = rep.get("join_map", {}).get("rows", [])
    if jm:
        lines += ["", "Join map (`recall_product_link` against `product`): " +
                  "; ".join(f"`{t}` {links} links, {inc} in the catalogue" for t, links, inc in jm) + "."]
    rj = rep.get("recall_join", {}).get("rows", [])
    if rj:
        prefixes = sorted({str(r[3])[:2] for r in rj})
        lines += ["", f"`product` ⨝ `recall_product_link` ⨝ `fda_recall` returns {len(rj)} rows "
                      f"(recall numbers with prefixes {', '.join(prefixes)})."]
    lines += ["", README_END]
    return "\n".join(lines)


def write_readme(summary: dict) -> None:
    text = README.read_text(encoding="utf-8")
    if README_START not in text or README_END not in text:
        raise OnboardError(f"{README} has no {README_START} ... {README_END} block")
    head, rest = text.split(README_START, 1)
    _, tail = rest.split(README_END, 1)
    write_text(README, head + readme_section(summary) + tail)


# --- CLI -----------------------------------------------------------------------

def parse_args(argv: list[str] | None) -> Args:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="print the plan; only read-only existence checks are sent")
    p.add_argument("--skip-exists", action="store_true", help="skip objects that already exist (idempotent rerun)")
    p.add_argument("--offline", action="store_true", help="with --dry-run: no connection, assume nothing exists")
    p.add_argument("--phases", default=",".join(PHASES), help=f"comma-separated subset of {','.join(PHASES)}")
    p.add_argument("--roles", default=",".join(manifest_mod.CATALOGUE_ROLES),
                   help="manifest roles to onboard (default: demo, the catalogue the gateway warm-up keeps cached)")
    p.add_argument("--gtin", action="append", default=[], help="register only this manifest GTIN (repeatable); "
                   "the activation still covers every registered SKU")
    p.add_argument("--off-gap", type=float, default=OFF_GAP_S, help=f"seconds between OFF calls (floor {OFF_GAP_FLOOR_S:g})")
    p.add_argument("--activate-all", action="store_true", help="re-activate all nine tables, not only the SKU tables")
    p.add_argument("--no-write", action="store_true", help="do not regenerate zetaris/ scripts or the README")
    a = p.parse_args(argv)
    phases = tuple(x.strip() for x in a.phases.split(",") if x.strip())
    roles = tuple(x.strip() for x in a.roles.split(",") if x.strip())
    if bad := [x for x in phases if x not in PHASES]:
        p.error(f"unknown phase(s): {bad}")
    if bad := [x for x in roles if x not in manifest_mod.ROLES]:
        p.error(f"unknown role(s): {bad}")
    if a.offline and not a.dry_run:
        p.error("--offline needs --dry-run")
    return Args(dry_run=a.dry_run, skip_exists=a.skip_exists, offline=a.offline, phases=phases, roles=roles,
                gtins=tuple(a.gtin), off_gap_s=a.off_gap, activate_all=a.activate_all, write_files=not a.no_write)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_env()
    conn = None if args.offline else LightningConnection.from_env("admin")
    try:
        return Onboarder(conn, args).execute()
    except (OnboardError, manifest_mod.ManifestError, ZetarisError, allowlist.Refused) as e:
        print(json.dumps({"phase": "error", "error": str(e)[:1000]}), flush=True)
        return 1
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
