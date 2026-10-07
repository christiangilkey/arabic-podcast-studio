"""Arabic search normalization."""

import pytest

from app import arabic


@pytest.mark.parametrize(
    "text,expected",
    [
        ("الْكِتَابُ", "الكتاب"),                 # tashkeel stripped
        ("أحمد", "احمد"),                         # hamza above alef
        ("إسلام", "اسلام"),                       # hamza below alef
        ("آمن", "امن"),                           # madda
        ("ٱلرَّحْمَٰن", "الرحمن"),                 # wasla + superscript alef + shadda
        ("مدرسة", "مدرسه"),                       # taa marbuta -> haa
        ("مدرسه", "مدرسه"),
        ("على", "علي"),                           # alef maqsura -> yaa
        ("مسؤول", "مسوول"),                       # hamza on waw
        ("قـــال", "قال"),                        # tatweel
        ("  كلمة\n\tأخرى  ", "كلمه اخري"),        # whitespace collapsed
        ("Hello World", "hello world"),
    ],
)
def test_normalize(text, expected):
    assert arabic.normalize(text) == expected


def test_variants_match_each_other():
    variants = ["الْمَدْرَسَةُ", "المدرسة", "المدرسه", "ألمدرسة"]
    assert len({arabic.normalize(v) for v in variants}) == 1


def test_normalize_never_mutates_input():
    original = "قَالَ"
    arabic.normalize(original)
    assert original == "قَالَ"


def test_find_spans_maps_back_to_diacritized_text():
    text = "ذَهَبَ أَحْمَدُ إِلَى الْمَدْرَسَةِ"
    spans = arabic.find_spans(text, "المدرسه")
    assert len(spans) == 1
    a, b = spans[0]
    assert text[a:b] == "الْمَدْرَسَةِ"  # includes the trailing kasra
    spans = arabic.find_spans(text, "احمد")
    assert [text[a:b] for a, b in spans] == ["أَحْمَدُ"]


def test_find_spans_multiple_and_substring():
    text = "الكتاب والكتاب كتابي"
    assert len(arabic.find_spans(text, "كتاب")) == 3


def test_find_spans_empty_query():
    assert arabic.find_spans("نص", "   ") == []
    assert arabic.find_spans("نص", "َ") == []  # only a diacritic


def test_search_endpoint_matches_without_diacritics(fresh_db):
    from fastapi.testclient import TestClient

    from app import db
    from app.main import create_app

    with db.session() as conn:
        conn.execute("INSERT INTO feeds(id, url, title, created_at) VALUES(1, 'u', 'Feed', 0)")
        conn.execute("INSERT INTO episodes(id, feed_id, guid, title, audio_url, created_at, status) "
                     "VALUES(1, 1, 'g', 'Ep', 'a', 0, 'done')")
        for idx, text in enumerate(["ذَهَبَ أَحْمَدُ إِلَى الْمَدْرَسَةِ", "قال لا"]):
            norm = arabic.normalize(text)
            conn.execute("INSERT INTO segments(episode_id, idx, start, end, text, norm) VALUES(1,?,?,?,?,?)",
                         (idx, idx * 5.0, idx * 5.0 + 4, text, norm))
            conn.execute("INSERT INTO segments_fts(norm, episode_id, seg_idx) VALUES(?,1,?)", (norm, idx))
    with TestClient(create_app(start_worker=False)) as client:
        r = client.get("/api/search", params={"q": "المدرسة"}).json()
        assert r["total"] == 1 and r["results"][0]["text"].startswith("ذَهَبَ")  # display text untouched
        assert client.get("/api/search", params={"q": "احمد"}).json()["total"] == 1
        assert client.get("/api/search", params={"q": "لا"}).json()["total"] == 1  # short query path
        assert client.get("/api/search", params={"q": "سيارة"}).json()["total"] == 0
