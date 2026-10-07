import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Isolate every test session from the real user data folder.
os.environ["APS_DATA_DIR"] = tempfile.mkdtemp(prefix="aps-test-")

FIXTURES = ROOT / "tests" / "fixtures"


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    """A brand-new empty database for one test."""
    from app import db, paths

    monkeypatch.setattr(paths, "db_path", lambda: tmp_path / "library.db")
    db.init_db(tmp_path / "library.db")
    return tmp_path / "library.db"
