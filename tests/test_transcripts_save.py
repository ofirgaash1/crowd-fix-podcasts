import os
import json
import tempfile
from pathlib import Path

import pytest

from explore.app import create_app


@pytest.fixture()
def client():
    with tempfile.TemporaryDirectory() as tmp:
        # data_root for app
        app = create_app(data_dir=tmp)
        app.config.update({
            'TESTING': True,
        })
        with app.test_client() as c:
            yield c


def test_save_flow_conflicts_and_success(client):
    doc = "folder/file.opus"
    # First save (no parent)
    r1 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': 'hello\nworld',
        'words': [
            {'word': 'hello', 'start': 0.0, 'end': 0.5, 'probability': 0.9},
            {'word': '\n', 'start': 0.5, 'end': 0.5, 'probability': None},
            {'word': 'world', 'start': 0.5, 'end': 1.0, 'probability': 0.8},
        ],
    })
    assert r1.status_code == 200
    payload1 = r1.get_json()
    assert payload1['version'] == 1
    base1 = payload1['base_sha256']

    # Second save missing expected_base_sha256 -> 409 hash_missing
    r2 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': 1,
        'text': 'hello\nworld!',
        'words': [
            {'word': 'hello'}, {'word': '\n'}, {'word': 'world!'}
        ],
    })
    assert r2.status_code == 409
    conf2 = r2.get_json()
    assert conf2['reason'] == 'hash_missing'
    assert 'latest' in conf2 and 'parent' in conf2

    # Second save wrong expected_base_sha256 -> 409 hash_conflict
    r3 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': 1,
        'expected_base_sha256': 'deadbeef',
        'text': 'hello\nworld!',
        'words': [
            {'word': 'hello'}, {'word': '\n'}, {'word': 'world!'}
        ],
    })
    assert r3.status_code == 409
    conf3 = r3.get_json()
    assert conf3['reason'] == 'hash_conflict'

    # Second save with correct hash -> success v2
    r4 = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': 1,
        'expected_base_sha256': base1,
        'text': 'hello\nworld!!',
        'words': [
            {'word': 'hello'}, {'word': '\n'}, {'word': 'world!!'}
        ],
    })
    assert r4.status_code == 200
    payload4 = r4.get_json()
    assert payload4['version'] == 2


def test_confirmations_hash_gate(client):
    doc = "folder/episode.opus"
    # Create baseline v1
    r = client.post('/transcripts/save', json={
        'doc': doc,
        'parentVersion': None,
        'expected_base_sha256': '',
        'text': 'abc',
        'words': [{'word': 'abc'}],
    })
    assert r.status_code == 200
    base = r.get_json()['base_sha256']

    # Missing base_sha256 -> 400
    r_bad = client.post('/transcripts/confirmations/save', json={
        'doc': doc,
        'version': 1,
        'items': [
            {'start_offset': 0, 'end_offset': 3, 'prefix': '', 'exact': 'abc', 'suffix': ''}
        ]
    })
    assert r_bad.status_code == 400

    # Wrong base -> 409
    r_wrong = client.post('/transcripts/confirmations/save', json={
        'doc': doc,
        'version': 1,
        'base_sha256': 'deadbeef',
        'items': [
            {'start_offset': 0, 'end_offset': 3, 'prefix': '', 'exact': 'abc', 'suffix': ''}
        ]
    })
    assert r_wrong.status_code == 409

    # Correct base -> OK
    r_ok = client.post('/transcripts/confirmations/save', json={
        'doc': doc,
        'version': 1,
        'base_sha256': base,
        'items': [
            {'start_offset': 0, 'end_offset': 3, 'prefix': '', 'exact': 'abc', 'suffix': ''}
        ]
    })
    assert r_ok.status_code == 200
    assert r_ok.get_json()['count'] == 1

