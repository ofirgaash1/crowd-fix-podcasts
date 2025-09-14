from __future__ import annotations

import hashlib
import json as pyjson
import difflib
import gzip
from pathlib import Path
from typing import Optional

import orjson
from flask import Blueprint, current_app, jsonify, request, abort, session
import subprocess
import io
import requests

from ..services.db import DatabaseService

# --- Lightweight, idempotent schema migrations ---
_TARGET_SCHEMA_VERSION = 3
# Default number of segments to return when segment is provided without count
_DEFAULT_SEGMENT_CHUNK = 50


def _get_user_version(db: DatabaseService) -> int:
    try:
        cur = db.execute("PRAGMA user_version")
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else 0
    except Exception:
        return 0


def _set_user_version(db: DatabaseService, v: int) -> None:
    db.execute(f"PRAGMA user_version = {int(v)}")


def _table_exists(db: DatabaseService, name: str) -> bool:
    cur = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name])
    return cur.fetchone() is not None


def _column_exists(db: DatabaseService, table: str, column: str) -> bool:
    try:
        cur = db.execute(f"PRAGMA table_info({table})")
        for r in cur.fetchall() or []:
            if len(r) >= 2 and str(r[1]).lower() == column.lower():
                return True
    except Exception:
        pass
    return False

bp = Blueprint("transcripts", __name__, url_prefix="/transcripts")


def _db() -> DatabaseService:
    path = current_app.config.get('SQLITE_PATH') or 'explore.sqlite'
    return DatabaseService(path=str(path))


def _ensure_schema(db: DatabaseService):
    """Create/upgrade schema in an idempotent, versioned manner.

    Uses SQLite PRAGMA user_version to track migrations.
    """
    current = _get_user_version(db)

    # v1: Base tables
    if current < 1:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                file_path   TEXT NOT NULL,
                version     INTEGER NOT NULL,
                base_sha256 TEXT NOT NULL,
                text        TEXT NOT NULL,
                words       TEXT NOT NULL,
                created_by  TEXT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (file_path, version)
            )
            """
        )
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
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS transcript_words (
                file_path     TEXT NOT NULL,
                version       INTEGER NOT NULL,
                segment_index INTEGER NOT NULL,
                word_index    INTEGER NOT NULL,
                word          TEXT NOT NULL,
                start_time    DOUBLE,
                end_time      DOUBLE,
                probability   DOUBLE,
                PRIMARY KEY (file_path, version, word_index)
            )
            """
        )
        # Helpful indexes
        db.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_doc_ver ON transcripts(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_edits_doc_child ON transcript_edits(file_path, child_version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_conf_doc_ver ON transcript_confirmations(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver_seg ON transcript_words(file_path, version, segment_index)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver ON transcript_words(file_path, version)")
        _set_user_version(db, 1)

    # v2: Backfill created_by column on transcripts if missing; add secondary indexes
    if current < 2:
        if not _column_exists(db, 'transcripts', 'created_by'):
            db.execute("ALTER TABLE transcripts ADD COLUMN created_by TEXT")
        # Ensure helpful indexes exist (idempotent)
        db.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_doc_ver ON transcripts(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_edits_doc_child ON transcript_edits(file_path, child_version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_conf_doc_ver ON transcript_confirmations(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver_seg ON transcript_words(file_path, version, segment_index)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver ON transcript_words(file_path, version)")
        _set_user_version(db, 2)

    # v3: Defensive create-if-missing for all tables and columns
    if current < 3:
        # Tables (no-op if already exist)
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                file_path   TEXT NOT NULL,
                version     INTEGER NOT NULL,
                base_sha256 TEXT NOT NULL,
                text        TEXT NOT NULL,
                words       TEXT NOT NULL,
                created_by  TEXT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (file_path, version)
            )
            """
        )
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
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS transcript_words (
                file_path     TEXT NOT NULL,
                version       INTEGER NOT NULL,
                segment_index INTEGER NOT NULL,
                word_index    INTEGER NOT NULL,
                word          TEXT NOT NULL,
                start_time    DOUBLE,
                end_time      DOUBLE,
                probability   DOUBLE,
                PRIMARY KEY (file_path, version, word_index)
            )
            """
        )
        # Indexes
        db.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_doc_ver ON transcripts(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_edits_doc_child ON transcript_edits(file_path, child_version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_conf_doc_ver ON transcript_confirmations(file_path, version)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver_seg ON transcript_words(file_path, version, segment_index)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tw_doc_ver ON transcript_words(file_path, version)")

        # Column backfills
        if not _column_exists(db, 'transcripts', 'created_by'):
            db.execute("ALTER TABLE transcripts ADD COLUMN created_by TEXT")

        _set_user_version(db, 3)

    db.commit()


def _sha256_hex(s: str) -> str:
    return hashlib.sha256((s or "").encode('utf-8')).hexdigest()


def _latest_row(db: DatabaseService, file_path: str) -> Optional[dict]:
    cur = db.execute(
        "SELECT version, base_sha256, text, words, COALESCE(created_by,'') FROM transcripts WHERE file_path=? ORDER BY version DESC LIMIT 1",
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
        "created_by": row[4] or "",
    }


def _row_for_version(db: DatabaseService, file_path: str, version: int) -> Optional[dict]:
    cur = db.execute(
        "SELECT version, base_sha256, text, words, COALESCE(created_by,'') FROM transcripts WHERE file_path=? AND version=?",
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
        "created_by": row[4] or "",
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
        elif not expected_base_sha256:
            # Require client to send expected_base_sha256 for non-first saves
            base = _row_for_version(db, doc, int(parent_version)) or {"text": ""}
            conflict_payload = {
                "reason": "hash_missing",
                "latest": latest,
                "parent": {"version": int(parent_version), "base_sha256": _sha256_hex(base.get('text') or ''), "text": base.get('text') or ''},
                "diff_parent_to_latest": _diff(base.get('text') or '', latest.get('text') or ''),
                "diff_parent_to_client": _diff(base.get('text') or '', text or '')
            }
        elif int(parent_version) != int(latest['version']):
            # Provide helpful diffs for client 3-way merge UI: base->latest and base->client
            base = _row_for_version(db, doc, int(parent_version)) or {"text": ""}
            conflict_payload = {
                "reason": "version_conflict",
                "latest": latest,
                "parent": {"version": int(parent_version), "base_sha256": _sha256_hex(base.get('text') or ''), "text": base.get('text') or ''},
                "diff_parent_to_latest": _diff(base.get('text') or '', latest.get('text') or ''),
                "diff_parent_to_client": _diff(base.get('text') or '', text or '')
            }
        elif expected_base_sha256 and expected_base_sha256 != str(latest['base_sha256']):
            base = _row_for_version(db, doc, int(parent_version)) or {"text": ""}
            conflict_payload = {
                "reason": "hash_conflict",
                "latest": latest,
                "parent": {"version": int(parent_version), "base_sha256": _sha256_hex(base.get('text') or ''), "text": base.get('text') or ''},
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
        user_email = session.get('user_email', '')
        db.execute(
            "INSERT INTO transcripts (file_path, version, base_sha256, text, words, created_by) VALUES (?, ?, ?, ?, ?, ?)",
            [doc, new_version, new_hash, text, words_json, user_email]
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


@bp.route('/edits', methods=['GET'])
def list_edits():
    doc = request.args.get('doc', '').strip()
    if not doc:
        abort(400, 'missing ?doc=')
    db = _db(); _ensure_schema(db)
    cur = db.execute(
        """
        SELECT parent_version, child_version, dmp_patch, token_ops
        FROM transcript_edits
        WHERE file_path=?
        ORDER BY child_version ASC
        """,
        [doc]
    )
    rows = cur.fetchall() or []
    out = [
        {"parent_version": r[0], "child_version": r[1], "dmp_patch": r[2], "token_ops": r[3]} for r in rows
    ]
    return jsonify(out)


@bp.route('/align_segment', methods=['POST'])
def align_segment():
    body = request.get_json(force=True, silent=False) or {}
    doc = (body.get('doc') or '').strip()
    version = body.get('version', None)
    seg = body.get('segment', None)
    # Neighbor window policy: clamp to [0, 3]
    try:
        neighbors = int(body.get('neighbors', 1) or 1)
    except Exception:
        neighbors = 1
    if neighbors < 0: neighbors = 0
    if neighbors > 3: neighbors = 3
    if not doc or seg is None:
        abort(400, 'missing doc/segment')

    db = _db(); _ensure_schema(db)
    # Resolve version (latest if not provided)
    if version is None:
        latest = _latest_row(db, doc)
        if not latest:
            abort(404, 'no transcript available')
        version = int(latest['version'])
    else:
        version = int(version)

    # Gather words for segments [seg-neighbors .. seg+neighbors]
    start_seg = max(0, int(seg) - max(0, neighbors))
    end_seg = int(seg) + max(0, neighbors)
    cur = db.execute(
        """
        SELECT segment_index, word_index, word, start_time, end_time, probability
        FROM transcript_words
        WHERE file_path=? AND version=? AND segment_index >= ? AND segment_index <= ?
        ORDER BY word_index ASC
        """,
        [doc, version, start_seg, end_seg]
    )
    rows = cur.fetchall() or []
    if not rows:
        return jsonify({ "ok": False, "reason": "no-words" }), 200

    # Build transcript text and time window
    words = []
    clip_start = None
    clip_end = None
    for seg_idx, wi, word, st, en, pr in rows:
        try:
            w = str(word or '')
        except Exception:
            w = ''
        words.append({ 'seg': seg_idx, 'wi': wi, 'word': w, 'start': st, 'end': en })
        if st is not None:
            clip_start = st if clip_start is None else min(clip_start, float(st))
        if en is not None:
            clip_end = en if clip_end is None else max(clip_end, float(en))

    transcript = ''.join(w['word'] for w in words)
    if clip_start is None or clip_end is None or clip_end <= clip_start:
        # No timings to slice; nothing to do
        return jsonify({ "ok": False, "reason": "no-timings" }), 200

    # Resolve audio path
    try:
        from ..utils import resolve_audio_path
        audio_path = resolve_audio_path(doc)
    except Exception:
        audio_path = None
    if not audio_path:
        return ("audio not found", 404)

    # Extract WAV clip via ffmpeg
    pad = 0.10
    ss = max(0.0, float(clip_start) - pad)
    to = float(clip_end) + pad
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-ss', f'{ss:.3f}', '-to', f'{to:.3f}', '-i', audio_path,
        '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        wav_bytes = p.stdout
    except Exception as e:
        return (f'ffmpeg failed: {getattr(e, "stderr", b"").decode("utf-8", "ignore")}', 500)

    # Call external alignment endpoint
    try:
        files = { 'audio': ('clip.wav', wav_bytes, 'audio/wav') }
        data = { 'transcript': transcript }
        r = requests.post('http://silence-remover.com:8000/align', files=files, data=data, timeout=60)
        if not r.ok:
            return (f'align endpoint error: {r.status_code} {r.text[:200]}', 502)
        res = r.json()
    except Exception as e:
        return (f'align request failed: {e}', 502)

    # Map response words to global times and compute diffs
    resp_words = (res or {}).get('words') or []
    offset = ss  # our clip starts at ss; align times relative to this
    # Filter out whitespace-only tokens from old words for comparison
    old_seq = [w for w in words if not (w['word'] or '').isspace()]
    diffs = []
    count = min(len(old_seq), len(resp_words))
    for i in range(count):
        ow = old_seq[i]
        rw = resp_words[i] or {}
        try:
            ow_text = str(ow.get('word') or '')
            rw_text = str(rw.get('word') or '')
        except Exception:
            ow_text = str(ow.get('word') or '')
            rw_text = str(rw.get('word') or '')
        # Only compare when strings match exactly
        if ow_text != rw_text:
            continue
        old_s = float(ow.get('start') or ow.get('end') or 0.0)
        old_e = float(ow.get('end') or ow.get('start') or 0.0)
        new_s = float(rw.get('start') or 0.0) + offset
        new_e = float(rw.get('end') or 0.0) + offset
        if not (new_e >= new_s):
            continue
        diffs.append({
            'word': ow_text,
            'old_start': old_s,
            'old_end': old_e,
            'new_start': new_s,
            'new_end': new_e,
            'delta_start': new_s - old_s,
            'delta_end': new_e - old_e,
            'segment_index': int(ow.get('seg') or seg),
        })

    # Update transcript_edits.token_ops for parent->child
    parent_version = max(0, version - 1)
    try:
        cur = db.execute(
            "SELECT dmp_patch, token_ops FROM transcript_edits WHERE file_path=? AND parent_version=? AND child_version=?",
            [doc, parent_version, version]
        )
        ex = cur.fetchone()
        dmp = ex[0] if ex else None
        prev_ops_raw = ex[1] if ex else None
        block = {
            'type': 'timing_adjust',
            'segment_start': start_seg,
            'segment_end': end_seg,
            'clip_start': ss,
            'clip_end': to,
            'items': diffs,
            'service': 'silence-remover',
        }
        try:
            ops = []
            if prev_ops_raw:
                parsed = orjson.loads(prev_ops_raw)
                if isinstance(parsed, list):
                    ops = parsed
                elif isinstance(parsed, dict):
                    ops = [parsed]
            ops.append(block)
            ops_json = orjson.dumps(ops).decode('utf-8')
        except Exception:
            ops_json = orjson.dumps([block]).decode('utf-8')

        db.execute(
            "INSERT OR REPLACE INTO transcript_edits (file_path, parent_version, child_version, dmp_patch, token_ops) VALUES (?, ?, ?, ?, ?)",
            [doc, parent_version, version, dmp, ops_json]
        )
        db.commit()
    except Exception:
        db.execute("ROLLBACK")
        raise

    return jsonify({
        'ok': True,
        'changed_count': len([d for d in diffs if abs(d.get('delta_start', 0)) > 1e-3 or abs(d.get('delta_end', 0)) > 1e-3]),
        'total_compared': len(diffs)
    })


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
               t.created_at,
               COALESCE(t.created_by,'')
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
        {"version": r[0], "parent_version": r[1], "hash": r[2], "created_at": r[3], "created_by": r[4]} for r in rows
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


@bp.route('/history', methods=['GET'])
def history():
    """Return version lineage for a document.

    Response: [ { version, parent_version, hash, created_at, created_by }, ... ]
    """
    doc = request.args.get('doc', '').strip()
    if not doc:
        abort(400, 'missing ?doc=')
    db = _db(); _ensure_schema(db)

    # Load all transcript versions
    cur = db.execute(
        """
        SELECT version, base_sha256, created_at, COALESCE(created_by,'')
        FROM transcripts WHERE file_path=? ORDER BY version ASC
        """,
        [doc]
    )
    rows = cur.fetchall() or []
    if not rows:
        return jsonify([])

    # Load explicit parent->child edges (if any)
    cur2 = db.execute(
        "SELECT parent_version, child_version FROM transcript_edits WHERE file_path=?",
        [doc]
    )
    edges = cur2.fetchall() or []
    parent_of = { int(cv): int(pv) for (pv, cv) in edges if pv is not None and cv is not None }

    out = []
    for ver, h, created_at, created_by in rows:
        v = int(ver)
        # Prefer explicit parent from edits; otherwise fall back to v-1 (or 0 for first)
        pv = parent_of.get(v)
        if pv is None:
            pv = 0 if v <= 1 else (v - 1)
        out.append({
            'version': v,
            'parent_version': int(pv),
            'hash': str(h or ''),
            'created_at': created_at,
            'created_by': created_by or ''
        })

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
        # If count provided use it, otherwise default to a safe chunk size
        if count_q.isdigit():
            end_seg = seg + max(0, int(count_q)) - 1
        else:
            end_seg = seg + _DEFAULT_SEGMENT_CHUNK - 1
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
        # Slice by counting newlines as segment boundaries and preserve newline tokens
        seg = int(seg_q)
        if count_q.isdigit():
            end_seg = seg + max(0, int(count_q)) - 1
        else:
            end_seg = seg + _DEFAULT_SEGMENT_CHUNK - 1

        out = []
        cur_seg = 0
        started = False
        for w in words:
            if not w:
                continue
            word_val = w.get('word') if isinstance(w, dict) else None
            if word_val == '\n':
                # If we've started collecting and reached the end segment, stop
                if started and cur_seg >= end_seg:
                    break
                # Advance segment counter, and if still within the requested window, include a newline token
                cur_seg += 1
                if started and cur_seg <= end_seg:
                    out.append({"word": "\n", "start": w.get('start') or 0.0, "end": w.get('start') or 0.0, "probability": None})
                continue
            # Skip words before the first requested segment
            if cur_seg < seg:
                continue
            started = True
            # Normalize fields and defaults
            out.append({
                "word": str(w.get('word') or ''),
                "start": float(w.get('start') or 0.0),
                "end": float(w.get('end') if w.get('end') is not None else (w.get('start') or 0.0)),
                "probability": (float(w.get('probability')) if (w.get('probability') is not None and w.get('probability') != '') else None),
            })
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
    if not base_sha256:
        abort(400, 'missing base_sha256')
    if not isinstance(items, list):
        abort(400, 'items must be an array')

    db = _db(); _ensure_schema(db)
    # Validate against stored version hash
    row = _row_for_version(db, doc, int(version))
    if not row:
        abort(404, 'version not found')
    if str(row['base_sha256']) != base_sha256:
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
    # CORS is applied centrally in app.after_request
    return resp
