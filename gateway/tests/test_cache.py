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
