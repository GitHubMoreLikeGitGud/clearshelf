"""Live checks against the local Zetaris instance. Run with CLEARSHELF_LIVE=1."""

import os

import pytest

from gateway.app import Gateway, TemplateRequest
from gateway.jdbc import load_env

pytestmark = pytest.mark.skipif(os.environ.get("CLEARSHELF_LIVE") != "1", reason="set CLEARSHELF_LIVE=1 to run against Zetaris")


@pytest.fixture(scope="module")
def gw():
    load_env()
    return Gateway()


def test_select_one(gw):
    status, body = gw.run_template(TemplateRequest(template_id="select_one"))
    assert status == 200 and body["rows"] == [[1]]


def test_recall_join_for_puffs(gw):
    status, body = gw.run_template(TemplateRequest(template_id="fda_notice", params={"recall_number": "H-1328-2026"}))
    assert status == 200 and body["row_count"] == 1 and body["cache_state"] in ("hit", "miss")
    status, body = gw.run_template(TemplateRequest(template_id="recalls_by_gtin", params={"gtin": "0816929000119"}))
    assert status == 200 and any(r[4] == "H-1328-2026" for r in body["rows"])
