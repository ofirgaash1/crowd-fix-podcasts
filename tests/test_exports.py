import tempfile
from pathlib import Path

from explore.app import create_app


def make_client():
    tmp = tempfile.TemporaryDirectory()
    app = create_app(data_dir=tmp.name)
    app.config.update({ 'TESTING': True })
    return tmp, app.test_client()


def test_transcript_exports_vtt_csv_json():
    tmp, client = make_client()
    try:
        doc = 'foo/bar.opus'
        words = [
            {'word': 'hello', 'start': 0.0, 'end': 0.4},
            {'word': ' ', 'start': 0.4, 'end': 0.5},
            {'word': '\n', 'start': 0.5, 'end': 0.5},
            {'word': 'world', 'start': 0.5, 'end': 1.0},
        ]
        text = ''.join(w['word'] for w in words)
        r = client.post('/transcripts/save', json={
            'doc': doc,
            'parentVersion': None,
            'expected_base_sha256': '',
            'text': text,
            'words': words,
        })
        assert r.status_code == 200

        rvtt = client.get(f'/export/transcript/vtt?doc={doc}')
        assert rvtt.status_code == 200
        vtt = rvtt.data.decode('utf-8')
        assert 'WEBVTT' in vtt and 'hello ' in vtt and 'world' in vtt

        rcsv = client.get(f'/export/transcript/csv?doc={doc}')
        assert rcsv.status_code == 200
        csv = rcsv.data.decode('utf-8')
        assert 'index,start,end,text' in csv.replace(' ', '')
        assert 'hello' in csv and 'world' in csv

        rjson = client.get(f'/export/transcript/json?doc={doc}')
        assert rjson.status_code == 200
        j = rjson.get_json()
        assert j['version'] == 1 and 'words' in j and j['text'] == text
    finally:
        tmp.cleanup()

