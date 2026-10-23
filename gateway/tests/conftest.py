import pytest

from gateway import cache, sqllog


@pytest.fixture(autouse=True)
def temp_sql_log(tmp_path, monkeypatch):
    path = tmp_path / "sql_log.jsonl"
    monkeypatch.setattr(sqllog, "LOG_PATH", path)
    monkeypatch.setattr(cache, "LOG_PATH", path)
    return path
