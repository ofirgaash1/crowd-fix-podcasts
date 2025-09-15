import tempfile
from pathlib import Path

import pytest

from explore.app import create_app


@pytest.fixture()
def client():
    with tempfile.TemporaryDirectory() as tmp:
        app = create_app(data_dir=tmp)
        app.config.update({ 'TESTING': True })
        with app.test_client() as c:
            yield c


def test_latest_empty(client):
    r = client.get('/transcripts/latest?doc=non/existent.opus')
    assert r.status_code == 200
    assert r.get_json() == {}


def test_save_get_words_history_confirmations(client):
    doc = 'fold/file.opus'
    # v1: two segments with newline token between
    words_v1 = [
        {'word': 'hello', 'start': 0.0, 'end': 0.5, 'probability': 0.9},
        {'word': ' ', 'start': 0.5, 'end': 0.6, 'probability': 0.95},
        {'word': '\n', 'start': 0.6, 'end': 0.6},
        {'word': 'world', 'start': 0.6, 'end': 1.0, 'probability': 0.8},
    ]
    text_v1 = ''.join(w['word'] for w in words_v1)
    rv1 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': text_v1,
        'words': words_v1,
    })
    assert rv1.status_code == 200
    v1 = rv1.get_json()['version']
    assert v1 == 1

    # latest/get
    r_latest = client.get(f'/transcripts/latest?doc={doc}')
    assert r_latest.status_code == 200
    latest = r_latest.get_json()
    assert latest and latest['version'] == 1

    r_get = client.get(f'/transcripts/get?doc={doc}&version=1')
    assert r_get.status_code == 200
    row = r_get.get_json()
    assert row['version'] == 1

    # words chunking: segment 0, count 1 → only first segment words (no \n)
    r_words = client.get(f'/transcripts/words?doc={doc}&version=1&segment=0&count=1')
    assert r_words.status_code == 200
    toks = r_words.get_json()
    assert isinstance(toks, list) and toks
    assert all(t['word'] != '\n' for t in toks)
    assert ''.join(t['word'] for t in toks) == 'hello '

    # history after second save
    rv2 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': 1,
        'expected_base_sha256': latest['base_sha256'],
        'text': text_v1 + '!',
        'words': words_v1 + [{'word': '!'}],
    })
    assert rv2.status_code == 200
    v2 = rv2.get_json()['version']
    assert v2 == 2

    rh = client.get(f'/transcripts/history?doc={doc}')
    assert rh.status_code == 200
    hist = rh.get_json()
    versions = [h['version'] for h in hist]
    assert 1 in versions and 2 in versions
    # Ensure v2 parent is 1
    pmap = {h['version']: h['parent_version'] for h in hist}
    assert pmap.get(2) == 1

    # confirmations list initially empty
    rc0 = client.get(f'/transcripts/confirmations?doc={doc}&version=2')
    assert rc0.status_code == 200
    assert rc0.get_json() == []

    # save one confirmation (full range)
    base_hash = rv2.get_json()['base_sha256']
    payload = {
        'doc': doc,
        'version': 2,
        'base_sha256': base_hash,
        'items': [
            { 'start_offset': 0, 'end_offset': len(text_v1)+1, 'prefix': '', 'exact': text_v1+'!', 'suffix': '' }
        ]
    }
    rc_save = client.post('/transcripts/confirmations/save', json=payload)
    assert rc_save.status_code == 200
    assert rc_save.get_json()['count'] == 1

    # list shows one
    rc1 = client.get(f'/transcripts/confirmations?doc={doc}&version=2')
    assert rc1.status_code == 200
    arr = rc1.get_json()
    assert isinstance(arr, list) and len(arr) == 1
    assert arr[0]['start_offset'] == 0 and arr[0]['end_offset'] == len(text_v1)+1


def test_words_default_chunk_and_align_fallbacks(client):
    doc = 'f/g.opus'
    # Build 3 segments via \n tokens; only first segment words have timings
    words = [
        {'word': 'a', 'start': 0.0, 'end': 0.1},
        {'word': 'b', 'start': 0.1, 'end': 0.2},
        {'word': '\n'},
        {'word': 'c'},  # no timings
        {'word': 'd'},
        {'word': '\n'},
        {'word': 'e'},
    ]
    text = ''.join(w.get('word','') for w in words)

    # Save v1 with mixed timing availability
    rv = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': text,
        'words': words,
    })
    assert rv.status_code == 200
    v1 = rv.get_json()['version']

    # Request words from segment=1 with no count (should default-chunk and include seg 1..)
    r = client.get(f'/transcripts/words?doc={doc}&version={v1}&segment=1')
    assert r.status_code == 200
    toks = r.get_json()
    # Should begin from segment 1 (tokens 'c','d', then newline, then 'e')
    s = ''.join(t.get('word','') for t in toks)
    assert s.startswith('cd\ne')
    # Newline tokens should be preserved between segments in response
    assert '\n' in s

    # Align fallbacks
    # Case 1: no-words → save a version with empty words list
    rv2 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': v1,
        'expected_base_sha256': rv.get_json()['base_sha256'],
        'text': text,
        'words': [],  # results in no transcript_words rows
    })
    assert rv2.status_code == 200
    v2 = rv2.get_json()['version']
    r_no_words = client.post('/transcripts/align_segment', json={ 'doc': doc, 'version': v2, 'segment': 0 })
    assert r_no_words.status_code == 200
    j = r_no_words.get_json()
    assert j.get('ok') is False and j.get('reason') == 'no-words'

    # Case 2: no-timings → segment window has words but all without timings
    # Use version 1 at segment 1..2 which we saved without timings
    r_no_timings = client.post('/transcripts/align_segment', json={ 'doc': doc, 'version': v1, 'segment': 1 })
    assert r_no_timings.status_code == 200
    jt = r_no_timings.get_json()
    assert jt.get('ok') is False and jt.get('reason') == 'no-timings'


def test_words_no_zero_length_spans_after_save(client):
    doc = 'tests/timing1.opus'
    # v1 includes a mix: some words with timings, some without (end missing)
    words_v1 = [
        {'word': 'א', 'start': 0.0, 'end': 0.10},
        {'word': ' ', 'start': 0.10, 'end': 0.20},
        {'word': 'ב', 'start': 0.20},  # end missing → should be normalized
        {'word': ' ', 'start': 0.25},  # end missing → should be normalized
        {'word': '\n'},
        {'word': 'ג', 'start': 0.50, 'end': 0.70},
        {'word': 'ד'},  # missing timings
    ]
    text_v1 = ''.join(w.get('word', '') for w in words_v1)
    rv1 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': text_v1,
        'words': words_v1,
    })
    assert rv1.status_code == 200
    v1 = rv1.get_json()['version']
    r_words = client.get(f'/transcripts/words?doc={doc}&version={v1}')
    assert r_words.status_code == 200
    toks = r_words.get_json()
    assert isinstance(toks, list) and len(toks) > 0
    # Ensure all non-newline tokens have end > start
    for t in toks:
        if t.get('word') == '\n':
            continue
        s = float(t.get('start') or 0.0)
        e = float(t.get('end') or 0.0)
        assert e > s, f"zero-length span for {t.get('word')} s={s} e={e}"


def test_carry_over_unchanged_tokens_keep_timings(client):
    doc = 'tests/timing2.opus'
    # v1 with clear timings
    words_v1 = [
        {'word': 'שלום', 'start': 0.00, 'end': 0.40},
        {'word': ' ',    'start': 0.40, 'end': 0.50},
        {'word': 'עולם', 'start': 0.50, 'end': 1.00},
    ]
    text_v1 = ''.join(w['word'] for w in words_v1)
    r1 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': text_v1,
        'words': words_v1,
    })
    assert r1.status_code == 200
    base_hash = r1.get_json()['base_sha256']

    # v2: append punctuation (new token), send words without timings → server should carry over unchanged timings
    text_v2 = text_v1 + '!'
    words_v2 = [ {'word': 'שלום'}, {'word': ' '}, {'word': 'עולם'}, {'word': '!'} ]
    r2 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': 1,
        'expected_base_sha256': base_hash,
        'text': text_v2,
        'words': words_v2,
    })
    assert r2.status_code == 200
    v2 = r2.get_json()['version']

    w1 = client.get(f'/transcripts/words?doc={doc}&version=1').get_json()
    w2 = client.get(f'/transcripts/words?doc={doc}&version={v2}').get_json()
    # Compare first two non-newline tokens (unchanged): timings should be identical
    def nonnl(arr):
        return [t for t in arr if t.get('word') != '\n']
    a1 = nonnl(w1)
    a2 = nonnl(w2)
    assert len(a1) >= 2 and len(a2) >= 2
    for i in range(2):
        assert a1[i]['word'] == a2[i]['word']
        assert abs(float(a1[i]['start']) - float(a2[i]['start'])) < 1e-9
        assert abs(float(a1[i]['end']) - float(a2[i]['end'])) < 1e-9
