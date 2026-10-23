import json
from datetime import datetime, timezone

from gateway import cache

STORAGE = {"app_id": "local-1", "started_at_ms": 0,
           "cached": {"clearshelf_fda.enforcement_undeclared", "clearshelf_off.off_0816929000119"}}


def test_hit_miss_uncached_unknown():
    fda = ("clearshelf_fda.enforcement_undeclared",)
    assert cache.cache_state(fda, {}, STORAGE)[0] == "hit"
    assert cache.cache_state(("clearshelf_fsa.allergy_alerts",), {}, STORAGE)[0] == "miss"
    assert cache.cache_state(("clearshelf_ops.decisions",), {}, STORAGE)[0] == "uncached"
    assert cache.cache_state(fda, {}, None)[0] == "unknown"
    state, detail, _ = cache.cache_state(("clearshelf_off.off_*", "clearshelf_ops.market_allergens"), {"gtin": "0816929000119"}, STORAGE)
    assert state == "hit" and detail["clearshelf_ops.market_allergens"] == "uncached_by_design"
    assert cache.cache_state(("clearshelf_off.off_*",), {"gtin": "4056489125846"}, STORAGE)[0] == "miss"


def test_off_wildcard_is_a_hit_only_when_every_catalogue_table_is_cached():
    targets = ["clearshelf_off.off_0816929000119", "clearshelf_off.off_5000254020408"]
    assert cache.cache_state(("clearshelf_off.off_*",), {}, STORAGE, targets)[0] == "miss"
    assert cache.cache_state(("clearshelf_off.off_*",), {}, STORAGE, targets[:1])[0] == "hit"


def test_cached_at_from_log_ignores_failures_and_events_before_driver_start(temp_sql_log):
    rows = [
        {"sql": "CACHE TABLE clearshelf_fda.enforcement_undeclared", "executed_at": "2026-10-23T07:00:00+0800", "error": None},
        {"sql": "CACHE TABLE clearshelf_fda.enforcement_undeclared", "executed_at": "2026-10-23T07:41:42+0800", "error": None},
        {"sql": "CACHE TABLE clearshelf_fsa.allergy_alerts", "executed_at": "2026-10-23T07:42:23+0800", "error": "boom"},
    ]
    temp_sql_log.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    assert cache.last_cache_events() == {"clearshelf_fda.enforcement_undeclared": "2026-10-23T07:41:42+0800"}
    started_ms = int(datetime(2026, 10, 22, 23, 50, tzinfo=timezone.utc).timestamp() * 1000)
    assert cache.last_cache_events(since_ms=started_ms) == {}


def test_wildcard_off_read_gets_the_oldest_cache_time_of_its_tables(temp_sql_log):
    rows = [
        {"sql": "CACHE TABLE clearshelf_off.off_0816929000119", "executed_at": "2026-10-23T07:10:00+0800", "error": None},
        {"sql": "CACHE TABLE clearshelf_off.off_5000254020408", "executed_at": "2026-10-23T07:05:00+0800", "error": None},
    ]
    temp_sql_log.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    targets = ["clearshelf_off.off_0816929000119", "clearshelf_off.off_5000254020408"]
    storage = {**STORAGE, "cached": STORAGE["cached"] | {"clearshelf_off.off_5000254020408"}}
    _, _, cached_at = cache.cache_state(("clearshelf_off.off_*", "clearshelf_ops.market_allergens"), {}, storage, targets)
    assert cached_at == {"clearshelf_off.off_*": "2026-10-23T07:05:00+0800"}
    # A specific GTIN keeps its own table's time.
    _, _, own = cache.cache_state(("clearshelf_off.off_*",), {"gtin": "0816929000119"}, storage, targets)
    assert own == {"clearshelf_off.off_0816929000119": "2026-10-23T07:10:00+0800"}
    # A table with no CACHE event since the driver started leaves the wildcard without a time.
    _, _, none = cache.cache_state(("clearshelf_off.off_*",), {}, storage, targets + ["clearshelf_off.off_4056489125846"])
    assert none == {}
