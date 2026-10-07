"""Definer backend: relay safety, answer cache, secret handling, cross-site protection."""

import sqlite3
import zipfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(fresh_db):
    from app.main import create_app

    with TestClient(create_app(start_worker=False)) as c:
        yield c


def test_relay_only_reaches_known_providers(client):
    for url in ["https://evil.example.com/v1/messages", "http://api.openai.com/v1/chat/completions",
                "https://api.openai.com.evil.com/x", "file:///etc/passwd"]:
        r = client.post("/api/llm/relay", json={"url": url, "headers": {}, "body": {}})
        assert r.status_code == 400, url


def test_relay_forwards_and_filters_headers(client, monkeypatch):
    import httpx

    seen = {}

    def fake_post(url, headers, content, timeout):
        seen.update(url=url, headers=headers, body=content.decode("utf-8"))
        return httpx.Response(200, text='{"ok": true}')

    monkeypatch.setattr(httpx, "post", fake_post)
    r = client.post("/api/llm/relay", json={
        "url": "https://api.anthropic.com/v1/messages",
        "headers": {"x-api-key": "k", "anthropic-version": "2023-06-01", "cookie": "steal-me"},
        "body": {"word": "كتاب"},
    }).json()
    assert r == {"status": 200, "text": '{"ok": true}'}
    assert seen["headers"] == {"x-api-key": "k", "anthropic-version": "2023-06-01"}
    assert "كتاب" in seen["body"]


def test_definition_cache_roundtrip(client):
    key = "a" * 40
    assert client.get(f"/api/definitions/{key}").json() is None
    data = {"word": "هون", "meaning": "here"}
    client.put(f"/api/definitions/{key}", json={"key": key, "word": "هون", "sentence": "انتي جديدة ⟦هون⟧", "data": data})
    assert client.get(f"/api/definitions/{key}").json() == data
    client.delete(f"/api/definitions/{key}")
    assert client.get(f"/api/definitions/{key}").json() is None


def test_cross_site_requests_are_rejected(client):
    assert client.get("/api/settings", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/llm/relay", headers={"Origin": "null"},
                       json={"url": "https://api.openai.com/v1/x", "headers": {}, "body": {}}).status_code == 403
    assert client.get("/api/settings", headers={"Origin": "http://127.0.0.1:5555"}).status_code == 200
    assert client.get("/api/settings").status_code == 200  # no Origin (same-origin GET, tools)


def test_backup_never_contains_api_keys(client, fresh_db, tmp_path):
    from app import backup, db

    db.set_settings({"llm_key_claude": "sk-ant-SECRET-123", "theme": "dark"})
    out = backup.export(include_audio=False)
    with zipfile.ZipFile(out) as zf:
        raw = zf.read("library.db")
    assert b"SECRET-123" not in raw  # not even in free pages
    (tmp_path / "x.db").write_bytes(raw)
    conn = sqlite3.connect(tmp_path / "x.db")
    keys = {r[0] for r in conn.execute("SELECT key FROM settings")}
    conn.close()
    assert "theme" in keys and "llm_key_claude" not in keys

    # Importing a backup keeps this device's keys.
    backup.import_(out)
    assert db.get_setting("llm_key_claude") == "sk-ant-SECRET-123"
