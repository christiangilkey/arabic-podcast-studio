"""Google sign-in flow (PKCE, state check, token storage) with Google's servers mocked."""

import base64
import hashlib
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app import db
from app.sync import oauth


@pytest.fixture()
def configured(fresh_db, monkeypatch):
    monkeypatch.setenv("APS_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setenv("APS_GOOGLE_CLIENT_SECRET", "csecret")
    oauth._access.update(token=None, expires=0.0)


def _id_token(email):
    payload = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).rstrip(b"=").decode()
    return f"h.{payload}.s"


def test_begin_builds_pkce_url(configured):
    url = oauth.begin("http://127.0.0.1:5000/api/sync/callback")
    q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    assert q["client_id"] == "cid.apps.googleusercontent.com"
    assert q["code_challenge_method"] == "S256"
    assert "drive.appdata" in q["scope"] and "drive " not in q["scope"] + " "
    verifier = oauth._pending[q["state"]]["verifier"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert q["code_challenge"] == expected


def test_complete_stores_refresh_token(configured, monkeypatch):
    url = oauth.begin("http://127.0.0.1:5000/api/sync/callback")
    state = parse_qs(urlsplit(url).query)["state"][0]
    sent = {}

    def fake_post(u, data=None, **kw):
        sent.update(data)
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600, "refresh_token": "rt",
                                         "scope": "https://www.googleapis.com/auth/drive.appdata openid email",
                                         "id_token": _id_token("me@example.com")})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert oauth.complete(state, "the-code") == "me@example.com"
    assert sent["code_verifier"] and sent["code"] == "the-code"
    assert db.get_setting("google_refresh_token") == "rt"
    assert oauth.access_token() == "at"
    with pytest.raises(oauth.AuthError):  # state is single-use
        oauth.complete(state, "the-code")


def test_unknown_state_rejected(configured):
    with pytest.raises(oauth.AuthError):
        oauth.complete("forged-state", "code")


def test_missing_drive_scope_rejected(configured, monkeypatch):
    url = oauth.begin("http://127.0.0.1:5000/api/sync/callback")
    state = parse_qs(urlsplit(url).query)["state"][0]
    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(
        200, json={"access_token": "at", "refresh_token": "rt", "scope": "openid email"}))
    with pytest.raises(oauth.AuthError, match="Drive access"):
        oauth.complete(state, "code")


def test_revoked_refresh_token_signs_out(configured, monkeypatch):
    db.set_settings({"google_refresh_token": "rt-old"})
    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(oauth.AuthError, match="expired"):
        oauth.access_token()
    assert not oauth.signed_in()
