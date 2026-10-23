import os

import pytest

from gateway import jdbc
from gateway.jdbc import ZetarisError, apply_user_agent, split_statements


def test_split_drops_comments_and_respects_quotes():
    text = "-- c1\nSELECT 'a;b' AS x;\n/* block; */ SELECT \"c;d\";\nSELECT 3"
    assert split_statements(text) == ["SELECT 'a;b' AS x", 'SELECT "c;d"', "SELECT 3"]


def test_split_keeps_compile_usl_whole():
    text = ("COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (x int);\n"
            "CREATE TABLE b (y int);\nUPDATE USL lightning.metastore.n.u SET DESCRIPTION x;")
    parts = split_statements(text)
    assert len(parts) == 2
    assert parts[0].count("CREATE TABLE") == 2 and not parts[0].endswith(";")


def test_user_agent_substitution(monkeypatch):
    monkeypatch.setenv("CLEARSHELF_USER_AGENT", "ClearShelf/0.1")
    assert apply_user_agent('user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"') == 'user-agent "ClearShelf/0.1"'
    assert apply_user_agent("SELECT 1") == "SELECT 1"


@pytest.mark.parametrize("ua", ["", "ClearShelf/0.1 <owner-contact-email>", 'ClearShelf "x"'])
def test_user_agent_refuses_placeholders(monkeypatch, ua):
    monkeypatch.setenv("CLEARSHELF_USER_AGENT", ua)
    with pytest.raises(ZetarisError):
        apply_user_agent('user-agent "YOUR_APP_NAME YOUR_CONTACT_EMAIL"')


def test_load_env_strips_crlf_and_does_not_override(tmp_path, monkeypatch):
    env = tmp_path / ".env.local"
    env.write_bytes(b'A_CS_TEST=from_file\r\nB_CS_TEST="quoted"\r\n# C_CS_TEST=x\r\n')
    monkeypatch.setenv("A_CS_TEST", "preset")
    monkeypatch.delenv("B_CS_TEST", raising=False)
    monkeypatch.delenv("C_CS_TEST", raising=False)
    jdbc.load_env(env)
    assert os.environ["A_CS_TEST"] == "preset"
    assert os.environ["B_CS_TEST"] == "quoted"
    assert "C_CS_TEST" not in os.environ
    monkeypatch.delenv("B_CS_TEST")
