"""Google sign-in for installed apps: system browser + loopback redirect + PKCE.

Only the `drive.appdata` scope is requested: the app sees its own hidden folder in the
user's Drive and nothing else.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from .. import db, paths

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
SCOPES = "https://www.googleapis.com/auth/drive.appdata openid email"


class AuthError(RuntimeError):
    pass


def client_config() -> tuple[str, str] | None:
    """OAuth client (Desktop app type). From env vars in development, or the file the release
    build bundles. Desktop-app client secrets aren't confidential (Google's own guidance)."""
    cid, secret = os.environ.get("APS_GOOGLE_CLIENT_ID"), os.environ.get("APS_GOOGLE_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    for candidate in (Path(__file__).with_name("google_client.json"), paths.resource_dir() / "app" / "sync" / "google_client.json"):
        if candidate.exists():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            return data["client_id"], data["client_secret"]
    return None


def configured() -> bool:
    return client_config() is not None


_lock = threading.Lock()
_pending: dict[str, dict[str, Any]] = {}  # state -> {verifier, redirect_uri, created}
_access: dict[str, Any] = {"token": None, "expires": 0.0}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def begin(redirect_uri: str) -> str:
    """Start sign-in. Returns the Google URL to open in the system browser."""
    cfg = client_config()
    if cfg is None:
        raise AuthError("Google sign-in isn't configured in this build.")
    verifier = _b64(secrets.token_bytes(48))
    state = _b64(secrets.token_bytes(24))
    with _lock:
        now = time.time()
        for k in [k for k, v in _pending.items() if now - v["created"] > 900]:
            del _pending[k]
        _pending[state] = {"verifier": verifier, "redirect_uri": redirect_uri, "created": now}
    params = {
        "client_id": cfg[0],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "code_challenge": _b64(hashlib.sha256(verifier.encode("ascii")).digest()),
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",  # always return a refresh token
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def _email_from_id_token(id_token: str | None) -> str:
    if not id_token:
        return ""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return str(json.loads(base64.urlsafe_b64decode(payload)).get("email", ""))
    except Exception:
        return ""


def complete(state: str, code: str) -> str:
    """Finish sign-in from the redirect. Returns the account email."""
    with _lock:
        pending = _pending.pop(state, None)
    if pending is None:
        raise AuthError("This sign-in link expired or was already used. Please try again from the app.")
    cid, secret = client_config() or ("", "")
    resp = httpx.post(TOKEN_URL, data={
        "code": code,
        "client_id": cid,
        "client_secret": secret,
        "redirect_uri": pending["redirect_uri"],
        "grant_type": "authorization_code",
        "code_verifier": pending["verifier"],
    }, timeout=30)
    if resp.status_code != 200:
        raise AuthError(f"Google sign-in failed: {resp.text[:300]}")
    data = resp.json()
    refresh = data.get("refresh_token")
    if not refresh:
        raise AuthError("Google didn't return a refresh token. Remove the app's access at "
                        "myaccount.google.com/permissions and sign in again.")
    granted = set(str(data.get("scope", "")).split())
    if "https://www.googleapis.com/auth/drive.appdata" not in granted:
        raise AuthError("Drive access wasn't granted. Sign in again and allow the app to store its data.")
    email = _email_from_id_token(data.get("id_token"))
    db.set_settings({"google_refresh_token": refresh, "google_email": email})
    with _lock:
        _access.update(token=data.get("access_token"), expires=time.time() + int(data.get("expires_in", 3600)) - 60)
    return email


def signed_in() -> bool:
    return bool(db.get_setting("google_refresh_token"))


def access_token(force_refresh: bool = False) -> str:
    with _lock:
        if not force_refresh and _access["token"] and time.time() < _access["expires"]:
            return str(_access["token"])
    refresh = db.get_setting("google_refresh_token")
    if not refresh:
        raise AuthError("Not signed in to Google.")
    cid, secret = client_config() or ("", "")
    resp = httpx.post(TOKEN_URL, data={"client_id": cid, "client_secret": secret, "refresh_token": refresh,
                                       "grant_type": "refresh_token"}, timeout=30)
    if resp.status_code in (400, 401):
        # Revoked or expired: sign out locally so the UI asks to sign in again.
        db.set_settings({"google_refresh_token": ""})
        raise AuthError("Your Google sign-in expired. Please sign in again.")
    resp.raise_for_status()
    data = resp.json()
    with _lock:
        _access.update(token=data["access_token"], expires=time.time() + int(data.get("expires_in", 3600)) - 60)
        return str(_access["token"])


def id_token() -> str:
    """A fresh Google ID token (proof of who is signed in), used to sign in to the app's online
    features. Google returns one with every refresh because the "openid" scope was granted."""
    refresh = db.get_setting("google_refresh_token")
    if not refresh:
        raise AuthError("Sign in with Google under “Sync with Google Drive” first.")
    cid, secret = client_config() or ("", "")
    resp = httpx.post(TOKEN_URL, data={"client_id": cid, "client_secret": secret, "refresh_token": refresh,
                                       "grant_type": "refresh_token"}, timeout=30)
    if resp.status_code in (400, 401):
        raise AuthError("Your Google sign-in expired. Sign out and in again under “Sync with Google Drive”.")
    resp.raise_for_status()
    data = resp.json()
    with _lock:
        _access.update(token=data["access_token"], expires=time.time() + int(data.get("expires_in", 3600)) - 60)
    if not data.get("id_token"):
        raise AuthError("Google didn't confirm your identity. Sign out and in again under “Sync with Google Drive”.")
    return str(data["id_token"])


def sign_out() -> None:
    refresh = db.get_setting("google_refresh_token")
    if refresh:
        try:
            httpx.post(REVOKE_URL, params={"token": refresh}, timeout=15)
        except httpx.HTTPError:
            pass
    db.set_settings({"google_refresh_token": "", "google_email": ""})
    with _lock:
        _access.update(token=None, expires=0.0)
