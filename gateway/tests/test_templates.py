import pytest

from gateway import allowlist, templates
from gateway.templates import BadParams, render

SAMPLES = {"gtin": "0816929000119", "fda_notice": "H-1328-2026", "fsa_notice": "FSA-AA-48-2026",
           "brand": "lidl", "market": "UK", "date": "2026-10-01"}


@pytest.mark.parametrize("tid", sorted(templates.TEMPLATES))
def test_every_template_renders_and_is_a_reader_statement(tid):
    t = templates.TEMPLATES[tid]
    params = {name: SAMPLES[kind] for name, kind in t.params.items()}
    _, sql = render(tid, params)
    assert "{" not in sql
    assert allowlist.check(sql, "reader") == "read"


@pytest.mark.parametrize("params", [
    {"gtin": "0816929000118"},
    {"gtin": "816929000119"},
    {"gtin": "0816929000119' OR '1'='1"},
    {"gtin": 816929000119},
    {"gtin": "0816929000119", "extra": "x"},
    {},
])
def test_bad_gtin_params(params):
    with pytest.raises(BadParams):
        render("product", params)


@pytest.mark.parametrize("tid,params", [
    ("recalls_by_name", {"brand": "lidl%"}),
    ("recalls_by_name", {"brand": "Lidl"}),
    ("recalls_by_name", {"brand": "x" * 41}),
    ("fda_notice", {"recall_number": "F-0422-2025x"}),
    ("fsa_allergens", {"notation": "FSA-PRIN-1-2026"}),
    ("market_list", {"market": "EU"}),
    ("fsa_recent", {"since": "2026-1-1"}),
    ("nope", {}),
])
def test_bad_params(tid, params):
    with pytest.raises(BadParams):
        render(tid, params)


@pytest.mark.parametrize("recall_number", ["H-1328-2026", "F-0636-2025", "F-1702-2024"])
def test_fda_notice_accepts_h_and_f_recall_numbers(recall_number):
    _, sql = render("fda_notice", {"recall_number": recall_number})
    assert sql.endswith(f"WHERE recall_number = '{recall_number}'")


@pytest.mark.parametrize("recall_number", ["Z-0636-2025", "f-0636-2025", "FH-0636-2025", "F-636-2025"])
def test_fda_notice_rejects_other_prefixes(recall_number):
    with pytest.raises(BadParams):
        render("fda_notice", {"recall_number": recall_number})


def _norm(sql: str) -> str:
    one = " ".join(sql.split())
    return one.replace("( ", "(").replace(" )", ")")


def test_recheck_cleared_is_the_corrected_query_in_the_14_select_script():
    # The current decision per (gtin, market) only, and >= so a same-day recall is flagged.
    _, sql = render("recheck_cleared", {})
    assert "MAX(decided_at) AS decided_at" in sql and "GROUP BY gtin, market" in sql
    assert "f.report_date >= d.decided_date" in sql and "f.report_date > d.decided_date" not in sql
    script = (templates_dir() / "14_decision_writeback_select.sql").read_text(encoding="utf-8")
    assert _norm(sql) in _norm(script)


def templates_dir():
    from gateway.jdbc import ROOT
    return ROOT / "zetaris" / "sql"


def test_substitution():
    _, sql = render("product", {"gtin": "4056489125846"})
    assert sql.endswith("WHERE gtin = '4056489125846'")
