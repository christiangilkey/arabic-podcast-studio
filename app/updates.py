"""Check GitHub Releases for a newer version."""

from __future__ import annotations

import re
from typing import Any

import httpx

from .version import GITHUB_REPO, __version__


def parse_version(v: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", v.split("-", 1)[0])
    return tuple(int(n) for n in nums[:3]) or (0,)


def is_newer(latest: str, current: str = __version__) -> bool:
    return parse_version(latest) > parse_version(current)


def check() -> dict[str, Any]:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    try:
        resp = httpx.get(url, timeout=15, follow_redirects=True,
                         headers={"Accept": "application/vnd.github+json"})
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"Couldn't reach GitHub: {exc}", "current": __version__}
    if resp.status_code == 404:
        return {"ok": True, "current": __version__, "latest": None, "update_available": False,
                "message": "No releases published yet."}
    if resp.status_code >= 400:
        return {"ok": False, "error": f"GitHub returned HTTP {resp.status_code}.", "current": __version__}
    data = resp.json()
    latest = str(data.get("tag_name", "")).lstrip("v")
    return {"ok": True, "current": __version__, "latest": latest, "update_available": is_newer(latest),
            "url": data.get("html_url"), "notes": (data.get("body") or "")[:2000]}
