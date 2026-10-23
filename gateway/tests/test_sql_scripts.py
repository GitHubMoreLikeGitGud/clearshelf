"""Static checks over zetaris/sql/, the OFF template, manifest and dq-rules.md."""

from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from pathlib import Path

import pytest

from gateway import allowlist, sqlgen
from gateway.jdbc import split_statements

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "zetaris" / "sql"
MANIFEST_PATH = ROOT / "zetaris" / "manifest.json"
TEMPLATE_PATH = ROOT / "zetaris" / "templates" / "off_product_template.sql"
DQ_RULES_PATH = ROOT / "zetaris" / "dq-rules.md"
LIST_DQ_PATH = ROOT / "data" / "curation" / "zetaris" / "list_dq_2026-10-23.json"
USL = "lightning.metastore.clearshelf.clearance_usl"

PAIR_RE = re.compile(r"^(\d{2})_(.+?)_(create|select)\.sql$")
DESCRIBE_BY_RE = re.compile(
    r'DESCRIBE\s+BY\s+(?:"([^"]*)"|\'([^\']*)\'|([^\n;]+))',
    re.I,
)
UA_RE = re.compile(r'user-agent\s+"([^"]*)"', re.I)
OBJECT_REF_RE = re.compile(
    r"\b(?:FROM|JOIN|TABLE)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)",
    re.I,
)
REST_FROM_RE = re.compile(
    r"CREATE\s+LIGHTNING\s+REST\s+TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+FROM\s+(\w+)",
    re.I,
)
CREATE_TABLE_RE = re.compile(r"CREATE\s+TABLE\s+(\w+)\s*\((.*?)\)\s*(?=;|$)", re.I | re.S)
PK_RE = re.compile(r"(\w+)\s+[\w()]+\s+NOT\s+NULL\s+PRIMARY\s+KEY", re.I)
FK_RE = re.compile(
    r"(\w+)\s+[\w()]+\s+NOT\s+NULL\s+FOREIGN\s+KEY\s+REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)",
    re.I,
)
REGISTER_DQ_RE = re.compile(
    rf"REGISTER\s+DQ\s+(\w+)\s+TABLE\s+{re.escape(USL)}\.(\w+)\s+AS\s+(.+)",
    re.I,
)
ACTIVATE_RE = re.compile(
    rf"ACTIVATE\s+USL\s+TABLE\s+{re.escape(USL)}\.(\w+)\s+AS\s+(.+)",
    re.I | re.S,
)
NOT_NULL_COL_RE = re.compile(r"(\w+)\s+[\w()]+\s+NOT\s+NULL", re.I)
# Template placeholders are {name}; exclude SQL regex quantifiers like {2}.
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
BANNED_FIELDS = (
    "address_1",
    "address_2",
    "postal_code",
    "creator",
    "last_editor",
    "editors_tags",
    "informers_tags",
    "correctors_tags",
    "photographers_tags",
    "checkers_tags",
)
BANNED_KEYWORDS = ("DROP", "GRANT", "REVOKE", "INVALIDATE CACHE", "8889")

EXPECTED_KEYS = {
    "market_allergen": {"pk": "market_code", "fks": []},
    "product": {"pk": "gtin", "fks": []},
    "declared_allergen": {
        "pk": "declared_key",
        "fks": [("gtin", "product"), ("market_code", "market_allergen")],
    },
    "extracted_allergen": {
        "pk": "extracted_key",
        "fks": [("gtin", "product"), ("market_code", "market_allergen")],
    },
    "fda_recall": {"pk": "recall_number", "fks": []},
    "fsa_alert": {"pk": "notation", "fks": []},
    "fsa_alert_allergen": {
        "pk": "alert_allergen_key",
        "fks": [("notation", "fsa_alert")],
    },
    "recall_product_link": {
        "pk": "link_key",
        "fks": [("recall_number", "fda_recall"), ("gtin", "product")],
    },
    "decision": {"pk": "decision_id", "fks": [("gtin", "product")]},
}

DQ_12 = {
    "has_ingredients": "ingredients_text IS NOT NULL AND length(trim(ingredients_text)) > 0",
    "english_label": (
        "lang = 'en' OR (ingredients_text_en IS NOT NULL AND length(trim(ingredients_text_en)) > 0)"
    ),
    "known_relation": "relation IN ('contains','may_contain','free_from_claim','not_allergen')",
}
DQ_14 = {
    "signed_clear": (
        "status NOT IN ('CLEAR','CLEAR_WITH_STATEMENT','RELEASE') OR "
        "(contract_id IS NOT NULL AND length(trim(contract_id)) > 0)"
    ),
    "known_status": "status IN ('CLEAR','CLEAR_WITH_STATEMENT','HOLD','BLOCK')",
}

ALL_OPTIONAL_FIELDS = {
    "code",
    "product_name",
    "brands",
    "lang",
    "ingredients_text",
    "ingredients_text_en",
    "allergens_tags",
    "traces_tags",
    "labels_tags",
    "countries_tags",
    "last_modified_t",
}
OPS_TABLES = ("market_allergen", "extracted_allergen", "recall_product_link", "decision")
OPS_PK = {
    "market_allergen": "market_code",
    "extracted_allergen": "extracted_key",
    "recall_product_link": "link_key",
    "decision": "decision_id",
}


def _norm(s: str) -> str:
    return " ".join(s.split())


def _coalesce_or_literal_as(branch: str, col: str) -> bool:
    """True if every projection of `col` is COALESCE(...) AS col or a quoted literal AS col."""
    if re.search(rf"(?:'[^']*'|\"[^\"]*\")\s+AS\s+{col}\b", branch, re.I):
        return True
    for m in re.finditer(r"\bCOALESCE\s*\(", branch, re.I):
        depth, i = 1, m.end()
        while i < len(branch) and depth:
            if branch[i] == "(":
                depth += 1
            elif branch[i] == ")":
                depth -= 1
            i += 1
        if re.match(rf"\s+AS\s+{col}\b", branch[i:], re.I):
            return True
    return False


def _sql_files() -> list[Path]:
    return sorted(SQL_DIR.glob("*.sql"))


def _pairs() -> dict[str, dict[str, Path]]:
    pairs: dict[str, dict[str, Path]] = defaultdict(dict)
    for path in _sql_files():
        m = PAIR_RE.match(path.name)
        assert m, f"unexpected sql name: {path.name}"
        pairs[f"{m.group(1)}_{m.group(2)}"][m.group(3)] = path
    return pairs


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_sql_files_are_paired():
    pairs = _pairs()
    assert pairs, "no sql files"
    for name, parts in pairs.items():
        assert "create" in parts and "select" in parts, f"unpaired: {name}"


def test_manifest_scripts_and_deps():
    pairs = _pairs()
    create_paths = {str(p["create"].relative_to(ROOT)).replace("\\", "/") for p in pairs.values()}
    data = _manifest()
    sources = data["sources"]
    ids = [s["id"] for s in sources]
    assert len(ids) == len(set(ids)), "duplicate manifest ids"
    scripts = [s["script"] for s in sources]
    assert len(scripts) == len(set(scripts)), "duplicate manifest scripts"
    for s in sources:
        assert Path(ROOT / s["script"]).is_file(), f"missing script {s['script']}"
        assert s["script"] in create_paths, f"script not a create file: {s['script']}"
        for req in s["requires"]:
            assert req in ids, f"unknown requires id {req} in {s['id']}"
    assert create_paths == set(scripts), (
        f"create files missing from manifest: {create_paths - set(scripts)}; "
        f"orphan scripts: {set(scripts) - create_paths}"
    )
    # Dependency graph: no cycles; only 00_ has empty requires.
    by_id = {s["id"]: s for s in sources}
    empty = [s for s in sources if not s["requires"]]
    assert len(empty) == 1
    assert empty[0]["script"].startswith("zetaris/sql/00_")
    indeg = {i: 0 for i in ids}
    edges: dict[str, list[str]] = defaultdict(list)
    for s in sources:
        for req in s["requires"]:
            edges[req].append(s["id"])
            indeg[s["id"]] += 1
    q = deque([i for i, d in indeg.items() if d == 0])
    seen = 0
    while q:
        n = q.popleft()
        seen += 1
        for m in edges[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    assert seen == len(ids), "manifest requires graph has a cycle"


def test_select_statements_pass_reader_allowlist():
    for path in _sql_files():
        if not path.name.endswith("_select.sql"):
            continue
        for s in split_statements(path.read_text(encoding="utf-8")):
            allowlist.check(s, "reader")
            assert not s.rstrip().endswith(";")


def test_pair14_create_passes_onboard_allowlist():
    path = SQL_DIR / "14_decision_writeback_create.sql"
    assert path.is_file()
    for s in split_statements(path.read_text(encoding="utf-8")):
        allowlist.check(s, "onboard")
        assert not s.rstrip().endswith(";")


def test_no_statement_ends_with_semicolon():
    for path in _sql_files():
        for s in split_statements(path.read_text(encoding="utf-8")):
            assert not s.rstrip().endswith(";"), path.name


def test_compile_usl_has_nine_tables_and_expected_keys():
    text = (SQL_DIR / "10_clearance_usl_create.sql").read_text(encoding="utf-8")
    stmts = split_statements(text)
    compiles = [s for s in stmts if re.match(r"^\s*COMPILE\s+USL\b", s, re.I)]
    assert len(compiles) == 1
    body = compiles[0]
    tables = {m.group(1): m.group(2) for m in CREATE_TABLE_RE.finditer(body)}
    assert set(tables) == set(EXPECTED_KEYS)
    for name, spec in EXPECTED_KEYS.items():
        cols = tables[name]
        pks = PK_RE.findall(cols)
        assert pks == [spec["pk"]], f"{name} pk: {pks}"
        fks = [(a, b) for a, b, _c in FK_RE.findall(cols)]
        assert fks == spec["fks"], f"{name} fks: {fks}"


def test_describe_by_and_user_agent_and_no_at():
    for path in _sql_files():
        text = path.read_text(encoding="utf-8")
        assert "@" not in text, path.name
        for m in DESCRIBE_BY_RE.finditer(text):
            desc = next(g for g in m.groups() if g is not None).strip()
            assert re.fullmatch(r"^[A-Za-z0-9 _.,-]+$", desc), (
                f"DESCRIBE BY in {path.name}: {desc!r}"
            )
        for m in UA_RE.finditer(text):
            assert m.group(1) == "YOUR_APP_NAME YOUR_CONTACT_EMAIL", path.name


def test_no_banned_fields_or_keywords_in_statements():
    for path in _sql_files():
        for s in split_statements(path.read_text(encoding="utf-8")):
            lower = s.lower()
            for field in BANNED_FIELDS:
                assert field not in lower, f"{path.name}: {field}"
            for kw in BANNED_KEYWORDS:
                assert kw.lower() not in lower, f"{path.name}: {kw}"


def test_object_refs_and_rest_from_clearshelf():
    for path in _sql_files():
        for s in split_statements(path.read_text(encoding="utf-8")):
            bare = allowlist._strip_literals(s)
            for m in OBJECT_REF_RE.finditer(bare):
                name = m.group(1)
                assert name.startswith("clearshelf_") or name.startswith(
                    "lightning.metastore.clearshelf"
                ), f"{path.name}: {name}"
            for m in REST_FROM_RE.finditer(s):
                assert re.fullmatch(r"CLEARSHELF_[A-Z]+", m.group(1)), f"{path.name}: {m.group(1)}"


def test_activate_script_covers_nine_tables_and_not_null_coalesce():
    ddl = (SQL_DIR / "10_clearance_usl_create.sql").read_text(encoding="utf-8")
    compile_stmt = next(
        s for s in split_statements(ddl) if re.match(r"^\s*COMPILE\s+USL\b", s, re.I)
    )
    not_null: dict[str, list[str]] = {}
    for m in CREATE_TABLE_RE.finditer(compile_stmt):
        table, cols = m.group(1), m.group(2)
        not_null[table] = NOT_NULL_COL_RE.findall(cols)

    text = (SQL_DIR / "11_clearance_usl_activate_create.sql").read_text(encoding="utf-8")
    stmts = split_statements(text)
    activated = []
    for s in stmts:
        m = ACTIVATE_RE.match(s.strip())
        assert m, f"expected ACTIVATE in 11_: {s[:60]}"
        table, body = m.group(1), m.group(2)
        activated.append(table)
        # Every UNION ALL branch must project NOT NULL columns as COALESCE or literal.
        branches = re.split(r"\bUNION\s+ALL\b", body, flags=re.I)
        for branch in branches:
            for col in not_null[table]:
                assert _coalesce_or_literal_as(branch, col), (
                    f"11_ {table}: NOT NULL {col} missing COALESCE/literal AS"
                )
        if table in OPS_TABLES:
            assert "LATERAL VIEW explode(data) x AS d" in body, table
            pk = OPS_PK[table]
            assert f"d.{pk} <> '__schema__'" in body, table
    assert set(activated) == set(EXPECTED_KEYS)
    assert len(activated) == 9


def test_register_dq_expressions():
    for path, expected in (
        (SQL_DIR / "12_clearance_dq_create.sql", DQ_12),
        (SQL_DIR / "14_decision_writeback_create.sql", DQ_14),
    ):
        found = {}
        for s in split_statements(path.read_text(encoding="utf-8")):
            m = REGISTER_DQ_RE.match(s.strip())
            assert m, f"expected REGISTER DQ in {path.name}"
            found[m.group(1)] = m.group(3).strip()
        assert found == expected, path.name


def test_off_template_matches_sqlgen_and_committed_04():
    assert TEMPLATE_PATH.is_file()
    tmpl = TEMPLATE_PATH.read_text(encoding="utf-8")
    placeholders = set(PLACEHOLDER_RE.findall(tmpl))
    assert placeholders == {"gtin13"}
    create_04 = (SQL_DIR / "04_off_products_create.sql").read_text(encoding="utf-8")
    stmts_04 = [_norm(s) for s in split_statements(create_04)]
    gtins = re.findall(
        r"CREATE\s+LIGHTNING\s+REST\s+TABLE\s+off_(\d{13})\b", create_04, re.I
    )
    assert gtins
    for gtin in gtins:
        filled = tmpl.replace("{gtin13}", gtin)
        # Strip comments for statement compare of CREATE/DESCRIBE/CACHE.
        filled_stmts = [_norm(s) for s in split_statements(filled)]
        create = _norm(sqlgen.create_off_table(gtin))
        describe = _norm(f"DESCRIBE clearshelf_off.off_{gtin}")
        cache = _norm(f"CACHE TABLE clearshelf_off.off_{gtin}")
        assert create in stmts_04
        assert describe in stmts_04
        assert cache in stmts_04
        assert create in filled_stmts
        assert describe in filled_stmts
        assert cache in filled_stmts
        sku = sqlgen.Sku(gtin, ["UK"], ALL_OPTIONAL_FIELDS)
        assert _norm(sqlgen.product_branch(sku)) in filled_stmts
        assert _norm(sqlgen.declared_branch(sku, "UK", "allergens_tags", "contains")) in filled_stmts
        assert _norm(sqlgen.create_off_table(gtin)) == create


def _expected_dq_rules() -> set[tuple[str, str]]:
    """(rule name, table) for every rule clearance_usl should list: one PK or FK
    rule per key column of the 10_ DDL (Zetaris names them after the column),
    plus the custom rules registered in 12_ and 14_."""
    ddl = (SQL_DIR / "10_clearance_usl_create.sql").read_text(encoding="utf-8")
    compile_stmt = next(s for s in split_statements(ddl) if re.match(r"^\s*COMPILE\s+USL\b", s, re.I))
    rules: set[tuple[str, str]] = set()
    for m in CREATE_TABLE_RE.finditer(compile_stmt):
        table, cols = m.group(1), m.group(2)
        rules.update((pk, table) for pk in PK_RE.findall(cols))
        rules.update((fk, table) for fk, _ref, _col in FK_RE.findall(cols))
    for name in ("12_clearance_dq_create.sql", "14_decision_writeback_create.sql"):
        for s in split_statements((SQL_DIR / name).read_text(encoding="utf-8")):
            m = REGISTER_DQ_RE.match(s.strip())
            rules.add((m.group(1), m.group(2)))
    return rules


def test_dq_rules_md_has_a_row_for_every_rule():
    assert DQ_RULES_PATH.is_file()
    text = DQ_RULES_PATH.read_text(encoding="utf-8")
    expected = _expected_dq_rules()
    assert len(expected) == 22  # 9 PK, 8 FK, 3 custom (12_), 2 custom (14_)
    for name, table in sorted(expected):
        # Rule names repeat across tables, so match the table row, not the name alone.
        assert re.search(rf"^\| `{re.escape(name)}` \| `{re.escape(table)}` \|", text, re.M), (
            f"dq-rules.md has no row for rule {name} on {table}"
        )
    assert "14_decision_writeback_create.sql" in text


def test_saved_list_dq_names_the_day0_rules():
    """The saved LIST DQ output is gitignored, so a fresh clone skips this."""
    if not LIST_DQ_PATH.is_file():
        pytest.skip("saved LIST DQ output not present (data/ is not committed)")
    rows = json.loads(LIST_DQ_PATH.read_text(encoding="utf-8"))["rows"]
    listed = {(name, table) for name, table, *_rest in rows}
    assert listed == _expected_dq_rules() - {("signed_clear", "decision"), ("known_status", "decision")}
