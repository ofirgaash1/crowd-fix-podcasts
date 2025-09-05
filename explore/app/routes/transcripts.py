from __future__ import annotations

import hashlib
import json as pyjson
import difflib
import gzip
from pathlib import Path
from typing import Optional

import orjson
from flask import Blueprint, current_app, jsonify, request, abort

from ..services.db import DatabaseService

bp = Blueprint("transcripts", __name__, url_prefix="/transcripts")


def _db() -> DatabaseService:
    path = current_app.config.get('SQLITE_PATH') or 'explore.sqlite'
    return DatabaseService(path=str(path))


def _ensure_schema(db: DatabaseService):
    # Transcripts (immutable versions)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS transcripts (
            file_path   TEXT NOT NULL,
            version     INTEGER NOT NULL,
            base_sha256 TEXT NOT NULL,
            text        TEXT NOT NULL,
            words       TEXT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (file_path, version)
        )
        """
    )
    # Event-sourced deltas between versions
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_edits (
            file_path      TEXT NOT NULL,
            parent_version INTEGER NOT NULL,
            child_version  INTEGER NOT NULL,
            dmp_patch      TEXT,
            token_ops      TEXT,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (file_path, parent_version, child_version)
        )
        """
    )
    # Confirmations anchored to specific version + hash
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_confirmations (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path    TEXT NOT NULL,
            version      INTEGER NOT NULL,
            base_sha256  TEXT NOT NULL,
            start_offset INTEGER NOT NULL,
            end_offset   INTEGER NOT NULL,
            prefix       TEXT,
            exact        TEXT,
            suffix       TEXT,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # Normalized per-word storage for transcript versions (scaffold + indexes)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_words (
            file_path    TEXT NOT NULL,
            version      INTEGER NOT NULL,
            segment_index INTEGER NOT NULL,
            word_index   INTEGER NOT NULL,
            word         TEXT NOT NULL,
            start_time   DOUBLE,
            end_time     DOUBLE,
            probability  DOUBLE,
            PRIMARY KEY (file_path, version, word_index)
        )
        """
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver_seg ON transcript_words(file_path, version, segment_index)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver ON transcript_words(file_path, version)")
    db.commit()


def _sha256_hex(s: str) -> str:
    return hashlib.sha256((s or "").encode('utf-8')).hexdigest()


def _latest_row(db: DatabaseService, file_path: str) -> Optional[dict]:
    cur = db.execute(
        "SELECT version, base_sha256, text, words FROM transcripts WHERE file_path=? ORDER BY version DESC LIMIT 1",
        [file_path],
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "version": row[0],
        "base_sha256": row[1],
        "text": row[2],
        "words": orjson.loads(row[3]) if row[3] else [],
    }


def _row_for_version(db: DatabaseService, file_path: str, version: int) -> Optional[dict]:
    cur = db.execute(
        "SELECT version, base_sha256, text, words FROM transcripts WHERE file_path=? AND version=?",
        [file_path, int(version)],
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "version": row[0],
        "base_sha256": row[1],
        "text": row[2],
        "words": orjson.loads(row[3]) if row[3] else [],
    }


def _diff(a: str, b: str) -> str:
    # Char-based unified diff for storage; compact but deterministic
    diff = difflib.unified_diff(a.splitlines(keepends=True), b.splitlines(keepends=True), n=0)
    return ''.join(diff)


def _populate_transcript_words(db: DatabaseService, doc: str, version: int, words: list):
    # Remove any existing rows for this version (shouldn't exist on new insert, but safe)
    db.execute("DELETE FROM transcript_words WHERE file_path=? AND version=?", [doc, int(version)])
    seg_idx = 0
    wrows = []
    for wi, w in enumerate(words or []):
        try:
            word = str(w.get('word', ''))
        except AttributeError:
            word = ''
        if word == '\n':
            seg_idx += 1
            continue
        start = w.get('start', None)
        end = w.get('end', None)
        prob = w.get('probability', None)
        wrows.append((doc, int(version), seg_idx, wi, word, start, end, prob))
    if wrows:
        db.batch_execute(
            """
            INSERT INTO transcript_words
              (file_path, version, segment_index, word_index, word, start_time, end_time, probability)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            wrows,
        )


@bp.route('/latest', methods=['GET'])
def get_latest():
    doc = request.args.get('doc', '').strip()
    if not doc:
        abort(400, 'missing ?doc=')
    db = _db(); _ensure_schema(db)
    row = _latest_row(db, doc)
    return jsonify(row or {})


@bp.route('/get', methods=['GET'])
def get_version():
    doc = request.args.get('doc', '').strip()
    version = request.args.get('version', '').strip()
    if not doc or not version.isdigit():
        abort(400, 'missing ?doc= and/or ?version=')
    db = _db(); _ensure_schema(db)
    row = _row_for_version(db, doc, int(version))
    if not row:
        abort(404, 'version not found')
    return jsonify(row)


@bp.route('/save', methods=['POST'])
def save_version():
    body = request.get_json(force=True, silent=False) or {}
    doc = (body.get('doc') or '').strip()
    parent_version = body.get('parentVersion', None)
    expected_base_sha256 = (body.get('expected_base_sha256') or '').strip()
    text = str(body.get('text') or '')
    words = body.get('words', [])
    if not doc:
        abort(400, 'missing doc')
    if not isinstance(words, list):
        abort(400, 'words must be an array')

    db = _db(); _ensure_schema(db)
    latest = _latest_row(db, doc)

    # Concurrency/consistency gate: parent version and hash must match current latest
    if latest:
        conflict_payload = None
        if parent_version is None:
            conflict_payload = {"reason": "missing_parent", "latest": latest}
        elif int(parent_version) != int(latest['version']):
            # Provide helpful diffs for client 3-way merge UI: base->latest and base->client
            base = _row_for_version(db, doc, int(parent_version)) or {"text": ""}
            conflict_payload = {
                "reason": "version_conflict",
                "latest": latest,
                "parent": {"version": parent_version, "base_sha256": _sha256_hex(base.get('text') or ''), "text": base.get('text') or ''},
                "diff_parent_to_latest": _diff(base.get('text') or '', latest.get('text') or ''),
                "diff_parent_to_client": _diff(base.get('text') or '', text or '')
            }
        elif expected_base_sha256 and expected_base_sha256 != str(latest['base_sha256']):
            base = _row_for_version(db, doc, int(parent_version)) or {"text": ""}
            conflict_payload = {
                "reason": "hash_conflict",
                "latest": latest,
                "parent": {"version": parent_version, "base_sha256": _sha256_hex(base.get('text') or ''), "text": base.get('text') or ''},
                "diff_parent_to_latest": _diff(base.get('text') or '', latest.get('text') or ''),
                "diff_parent_to_client": _diff(base.get('text') or '', text or '')
            }
        if conflict_payload is not None:
            return (jsonify(conflict_payload), 409)
    else:
        # first version
        if parent_version not in (None, 0, '0'):
            return ("invalid parentVersion for first save", 400)

    # Compute new version + hash of new text
    new_version = (latest['version'] + 1) if latest else 1
    new_hash = _sha256_hex(text)

    # Serialize words for storage
    words_json = orjson.dumps(words).decode('utf-8')

    # Begin transaction
    db.execute("BEGIN TRANSACTION")
    try:
        db.execute(
            "INSERT INTO transcripts (file_path, version, base_sha256, text, words) VALUES (?, ?, ?, ?, ?)",
            [doc, new_version, new_hash, text, words_json]
        )
        # Populate normalized words rows for this version
        _populate_transcript_words(db, doc, new_version, words)

        # Store edit deltas relative to parent (if exists)
        if latest:
            d_parent = _diff(latest['text'] or '', text)
            db.execute(
                "INSERT OR REPLACE INTO transcript_edits (file_path, parent_version, child_version, dmp_patch, token_ops) VALUES (?, ?, ?, ?, ?)",
                [doc, int(latest['version']), new_version, d_parent, None]
            )

        # Also store delta relative to origin (v1) for fast replay
        if latest and latest['version'] >= 1:
            # Fetch v1
            v1 = _row_for_version(db, doc, 1)
            if v1:
                d_origin = _diff(v1['text'] or '', text)
                db.execute(
                    "INSERT OR REPLACE INTO transcript_edits (file_path, parent_version, child_version, dmp_patch, token_ops) VALUES (?, ?, ?, ?, ?)",
                    [doc, 1, new_version, d_origin, None]
                )

        db.commit()
    except Exception:
        db.execute("ROLLBACK")
        raise

    return jsonify({ "version": new_version, "base_sha256": new_hash })


@bp.route('/history', methods=['GET'])
def history():
    doc = request.args.get('doc', '').strip()
    if not doc:
        abort(400, 'missing ?doc=')
    db = _db(); _ensure_schema(db)
    cur = db.execute(
        """
        SELECT t.version,
               COALESCE(e.parent_version, NULL) AS parent_version,
               t.base_sha256,
               t.created_at
        FROM transcripts t
        LEFT JOIN transcript_edits e
          ON e.file_path = t.file_path AND e.child_version = t.version AND e.parent_version = t.version - 1
        WHERE t.file_path = ?
        ORDER BY t.version ASC
        """,
        [doc]
    )
    rows = cur.fetchall() or []
    out = [
        {"version": r[0], "parent_version": r[1], "hash": r[2], "created_at": r[3]} for r in rows
    ]
    return jsonify(out)


@bp.route('/migrate_words', methods=['POST'])
def migrate_words():
    body = request.get_json(force=True, silent=False) or {}
    doc = (body.get('doc') or '').strip()
    version = body.get('version', None)
    if not doc:
        abort(400, 'missing doc')
    db = _db(); _ensure_schema(db)

    def _synth_words(text: str) -> list:
        # naive synthesis: split by whitespace; no timings/probabilities
        words = []
        seg_idx = 0
        idx = 0
        for line in (text or '').splitlines():
            parts = [p for p in line.split() if p]
            for p in parts:
                words.append({ 'word': p, 'start': None, 'end': None, 'probability': None })
                idx += 1
            seg_idx += 1
            words.append({ 'word': '\n' })
        return words

    rows = []
    if version is None:
        cur = db.execute("SELECT version, text, words FROM transcripts WHERE file_path=? ORDER BY version ASC", [doc])
        rows = cur.fetchall() or []
    else:
        cur = db.execute("SELECT version, text, words FROM transcripts WHERE file_path=? AND version=?", [doc, int(version)])
        r = cur.fetchone()
        if r:
            rows = [r]

    migrated = 0
    db.execute("BEGIN TRANSACTION")
    try:
        for (ver, text, words_json) in rows:
            try:
                words = orjson.loads(words_json) if words_json else None
            except Exception:
                words = None
            if not isinstance(words, list) or not words:
                words = _synth_words(text or '')
            _populate_transcript_words(db, doc, int(ver), words)
            migrated += 1
        db.commit()
    except Exception:
        db.execute("ROLLBACK")
        raise
    return jsonify({ 'migrated_versions': migrated })


@bp.route('/confirmations', methods=['GET'])
def get_confirmations():
    doc = request.args.get('doc', '').strip()
    version = request.args.get('version', '').strip()
    if not doc or not version.isdigit():
        abort(400, 'missing ?doc= and/or ?version=')
    db = _db(); _ensure_schema(db)
    cur = db.execute(
        "SELECT id, start_offset, end_offset, prefix, exact, suffix FROM transcript_confirmations WHERE file_path=? AND version=? ORDER BY start_offset ASC",
        [doc, int(version)]
    )
    rows = cur.fetchall() or []
    out = [
        {"id": r[0], "start_offset": r[1], "end_offset": r[2], "prefix": r[3], "exact": r[4], "suffix": r[5]}
        for r in rows
    ]
    return jsonify(out)


@bp.route('/words', methods=['GET'])
def get_words():
    doc = request.args.get('doc', '').strip()
    version = request.args.get('version', '').strip()
    seg_q = request.args.get('segment', '').strip()
    count_q = request.args.get('count', '').strip()
    if not doc or not version.isdigit():
        abort(400, 'missing ?doc= and/or ?version=')
    db = _db(); _ensure_schema(db)
    # Try normalized table first
    params = [doc, int(version)]
    seg_filter_sql = ''
    if seg_q.isdigit():
        seg = int(seg_q)
        seg_filter_sql = ' AND segment_index >= ?'
        params.append(seg)
        if count_q.isdigit():
            end_seg = seg + max(0, int(count_q)) - 1
            seg_filter_sql += ' AND segment_index <= ?'
            params.append(end_seg)

    cur = db.execute(
        f"""
        SELECT segment_index, word_index, word, start_time, end_time, probability
        FROM transcript_words
        WHERE file_path=? AND version=?{seg_filter_sql}
        ORDER BY word_index ASC
        """,
        params
    )
    rows = cur.fetchall() or []
    if rows:
        out = []
        last_seg = None
        for seg, wi, word, st, en, pr in rows:
            # insert newline token when segment changes (except first)
            if last_seg is not None and seg != last_seg:
                out.append({"word": "\n", "start": st or 0.0, "end": st or 0.0, "probability": None})
            out.append({
                "word": word,
                "start": float(st) if st is not None else 0.0,
                "end": float(en) if en is not None else (float(st) if st is not None else 0.0),
                "probability": float(pr) if pr is not None else None,
            })
            last_seg = seg
        return jsonify(out)

    # Fallback: use stored JSON words (optionally segment-sliced)
    row = _row_for_version(db, doc, int(version))
    if not row:
        abort(404, 'version not found')
    words = row.get('words') or []
    if seg_filter_sql:
        # Slice by counting newlines as segment boundaries
        seg = int(seg_q)
        end_seg = None
        if count_q.isdigit():
            end_seg = seg + max(0, int(count_q)) - 1
        out = []
        cur_seg = 0
        started = False
        for w in words:
            if w and w.get('word') == '\n':
                if started and end_seg is not None and cur_seg >= end_seg:
                    break
                cur_seg += 1
                continue
            if cur_seg < seg:
                continue
            started = True
            out.append(w)
        return jsonify(out)
    return jsonify(words)


@bp.route('/confirmations/save', methods=['POST'])
def save_confirmations():
    body = request.get_json(force=True, silent=False) or {}
    doc = (body.get('doc') or '').strip()
    version = body.get('version', None)
    base_sha256 = (body.get('base_sha256') or '').strip()
    items = body.get('items', [])
    if not doc or not version:
        abort(400, 'missing doc/version')
    if not isinstance(items, list):
        abort(400, 'items must be an array')

    db = _db(); _ensure_schema(db)
    # Validate against stored version hash
    row = _row_for_version(db, doc, int(version))
    if not row:
        abort(404, 'version not found')
    if base_sha256 and str(row['base_sha256']) != base_sha256:
        return ("hash conflict: confirmations base_sha256 mismatch", 409)

    # Replace confirmations transactionally
    db.execute("BEGIN TRANSACTION")
    try:
        db.execute("DELETE FROM transcript_confirmations WHERE file_path=? AND version=?", [doc, int(version)])
        for it in items:
            s = int(it.get('start_offset') or 0)
            e = int(it.get('end_offset') or s)
            pre = str(it.get('prefix') or '')
            ex = str(it.get('exact') or '')
            suf = str(it.get('suffix') or '')
            db.execute(
                "INSERT INTO transcript_confirmations (file_path, version, base_sha256, start_offset, end_offset, prefix, exact, suffix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [doc, int(version), row['base_sha256'], s, e, pre, ex, suf]
            )
        db.commit()
    except Exception:
        db.execute("ROLLBACK")
        raise

    return jsonify({"count": len(items)})


@bp.after_request
def add_cors(resp):
    try:
        resp.headers.setdefault('Access-Control-Allow-Origin', '*')
        resp.headers.setdefault('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        resp.headers.setdefault('Access-Control-Allow-Headers', 'Content-Type')
    except Exception:
        pass
    return resp
