from __future__ import annotations

import hashlib
import difflib
import os
import logging
from typing import Optional

import orjson
from flask import Blueprint, current_app, jsonify, request, abort, session
import subprocess
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
logger = logging.getLogger(__name__)


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


def _normalize_end_times(db: DatabaseService, doc: str, version: int, min_dur: float = 0.20) -> int:
    """Ensure each token in transcript_words for (doc,version) has end_time > start_time.
    Uses next token's start within each segment when available; otherwise start + min_dur.
    Returns number of rows updated.
    """
    cur = db.execute(
        """
        SELECT segment_index, word_index, start_time, end_time
        FROM transcript_words
        WHERE file_path=? AND version=?
        ORDER BY segment_index ASC, word_index ASC
        """,
        [doc, int(version)]
    )
    rows = cur.fetchall() or []
    updated = []
    # Group by segment
    seg_map = {}
    for seg, wi, st, en in rows:
        seg_map.setdefault(int(seg), []).append([int(wi), float(st) if st is not None else 0.0, float(en) if en is not None else None])
    for seg, items in seg_map.items():
        n = len(items)
        for i in range(n):
            wi, s, e = items[i]
            # Compute target end
            te = e if (e is not None and e > s) else None
            if te is None:
                # next token start within segment if greater
                ns = None
                for j in range(i+1, n):
                    ns_candidate = items[j][1]
                    if ns_candidate > s:
                        ns = ns_candidate; break
                te = ns if (ns is not None) else (s + float(min_dur))
            # Update if changed or invalid
            if e is None or te > e or e <= s:
                updated.append((float(te), doc, int(version), int(wi)))
    if updated:
        db.batch_execute(
            "UPDATE transcript_words SET end_time=? WHERE file_path=? AND version=? AND word_index=?",
            updated
        )
    return len(updated)

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
    seg_hint = body.get('segment', None)
    neighbors = int(body.get('neighbors', 1) or 1)
    if neighbors < 0: neighbors = 0
    if neighbors > 3: neighbors = 3
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

    # Serialize words for storage (will update after carry-over enrichment)
    words_json = orjson.dumps(words).decode('utf-8')
    try:
        _wt = 0
        for _w in (words or []):
            try:
                s = float(_w.get('start')) if _w.get('start') is not None else 0.0
                e = float(_w.get('end')) if _w.get('end') is not None else 0.0
                if s > 0 or e > 0: _wt += 1
            except Exception:
                pass
        logger.info(f"[SAVE] incoming words: count={len(words or [])} with_timing={_wt} latest_ver={(latest or {}).get('version', 0)} seg_hint={seg_hint}")
    except Exception:
        pass

    # Attempt alignment BEFORE saving (atomic):
    # Derive window from previous version timings if available
    updates = []  # (start_time, end_time, file_path, version, word_index)
    token_ops_block = None
    if latest and seg_hint is not None:
        try:
            seg_hint = int(seg_hint)
            start_seg = max(0, int(seg_hint) - max(0, neighbors))
            end_seg = int(seg_hint) + max(0, neighbors)
            # Gather previous timings to determine clip
            cur = db.execute(
                """
                SELECT segment_index, word_index, word, start_time, end_time, probability
                FROM transcript_words
                WHERE file_path=? AND version=? AND segment_index >= ? AND segment_index <= ?
                ORDER BY word_index ASC
                """,
                [doc, int(latest['version']), start_seg, end_seg]
            )
            prev_rows = cur.fetchall() or []
            clip_start = None; clip_end = None
            for seg_i, wi, w, st, en, pr in prev_rows:
                if st is not None:
                    clip_start = st if clip_start is None else min(clip_start, float(st))
                if en is not None:
                    clip_end = en if clip_end is None else max(clip_end, float(en))
            if clip_start is None or clip_end is None or clip_end <= clip_start:
                # Skip pre-align when no timings exist in the previous window
                clip_start = None; clip_end = None
                updates = []
                token_ops_block = None
                raise RuntimeError('prealign-skip:no-timings')
            # Build new window transcript and mapping of word indices
            new_window = []  # (global_word_index, word, seg)
            seg_idx = 0
            for wi, w in enumerate(words or []):
                try:
                    t = str(w.get('word') or '')
                except Exception:
                    t = ''
                if t == '\n':
                    seg_idx += 1
                    continue
                if seg_idx >= start_seg and seg_idx <= end_seg:
                    new_window.append((wi, t, seg_idx))
            new_transcript = ''.join(t for _, t, _ in new_window)
            # Resolve audio
            from ..utils import resolve_audio_path
            audio_path = resolve_audio_path(doc)
            if not audio_path:
                # Skip pre-align if audio is missing; allow save to proceed
                updates = []
                token_ops_block = None
                raise RuntimeError('prealign-skip:audio-not-found')
            # Pointer deref safety
            try:
                if os.path.isfile(audio_path) and os.path.getsize(audio_path) <= 512:
                    with open(audio_path, 'rb') as _pf:
                        data = _pf.read(512)
                    import re as _re
                    m = _re.search(r'([A-Fa-f0-9]{40,64})', data.decode('utf-8','ignore'))
                    if m:
                        sha = m.group(1)
                        audio_dir = current_app.config.get('AUDIO_DIR')
                        if audio_dir:
                            cand = os.path.join(audio_dir, 'blobs', sha)
                            if os.path.exists(cand):
                                audio_path = cand
            except Exception:
                pass
            # Extract clip
            pad = 0.10
            ss = max(0.0, float(clip_start) - pad)
            to = float(clip_end) + pad
            cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-ss', f'{ss:.3f}', '-to', f'{to:.3f}', '-i', audio_path,
                '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'
            ]
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            wav_bytes = p.stdout
            # Align
            files = { 'audio': ('clip.wav', wav_bytes, 'audio/wav') }
            data = { 'transcript': new_transcript }
            r = requests.post(current_app.config.get('ALIGN_ENDPOINT', 'http://silence-remover.com:8000/align'), files=files, data=data, timeout=60)
            if not r.ok:
                # Skip pre-align on endpoint error; allow save to proceed
                updates = []
                token_ops_block = None
                raise RuntimeError(f'prealign-skip:endpoint {r.status_code}')
            res = r.json()
            resp_words = (res or {}).get('words') or []
            try:
                _smpl = [(str((w or {}).get('word') or ''), (w or {}).get('start'), (w or {}).get('end')) for w in (resp_words[:10] or [])]
                logger.info(f"[ALIGN] prealign response: words={len(resp_words)} sample={_smpl}")
            except Exception:
                pass
            # Map by order of non-whitespace tokens; ensure non-zero durations
            offset = ss
            matched = 0
            MIN_DUR = 0.20
            def _norm(s):
                try:
                    return str(s or '').strip()
                except Exception:
                    return ''
            new_seq = [(i, _norm(t)) for (i, t, _seg) in new_window if _norm(t) != '']
            resp_seq = [((w or {}), _norm((w or {}).get('word'))) for w in (resp_words or []) if _norm((w or {}).get('word')) != '']
            m = min(len(new_seq), len(resp_seq))
            for k in range(m):
                wi, _t = new_seq[k]
                rw, _rt = resp_seq[k]
                try:
                    rs = float(rw.get('start') or 0.0) + offset
                except Exception:
                    rs = offset
                try:
                    re = float(rw.get('end') or 0.0) + offset
                except Exception:
                    re = rs
                if not (re > rs):
                    # Try next response start
                    next_rs = None
                    if (k + 1) < m:
                        try:
                            rn = resp_seq[k+1][0]
                            next_rs = float(rn.get('start') or 0.0) + offset
                        except Exception:
                            next_rs = None
                    re = next_rs if (next_rs is not None and next_rs > rs) else (rs + MIN_DUR)
                updates.append((rs, re, wi))
                matched += 1
            try:
                logger.info(f"[ALIGN] prealign mapping: new_seq={len(new_seq)} resp_seq={len(resp_seq)} matched={matched} updates={len(updates)}")
            except Exception:
                pass
            if matched == 0:
                # No token matched; skip pre-align
                updates = []
                token_ops_block = None
                raise RuntimeError('prealign-skip:no-match')
            # Prepare token_ops block
            token_ops_block = {
                'type': 'timing_adjust',
                'segment_start': start_seg,
                'segment_end': end_seg,
                'clip_start': ss,
                'clip_end': to,
                'items': [ { 'word_index': wi, 'new_start': s, 'new_end': e } for (s,e,wi) in updates ],
                'service': 'silence-remover',
            }
        except Exception as e:
            # Any pre-align failure should not block saving the version; continue gracefully
            try:
                logger.info(f"[ALIGN] prealign skipped: {str(e)}")
            except Exception:
                pass
            updates = []
            token_ops_block = None

    # Carry over timings/probabilities from previous version for unchanged tokens
    try:
        if latest and isinstance(words, list) and words:
            cur = db.execute(
                """
                SELECT word_index, word, start_time, end_time, probability
                FROM transcript_words
                WHERE file_path=? AND version=?
                ORDER BY word_index ASC
                """,
                [doc, int(latest['version'])]
            )
            prev_rows = cur.fetchall() or []
            prev_seq = []  # list of dicts without newlines (since DB doesn't store them)
            for wi, w, st, en, pr in prev_rows:
                try:
                    prev_seq.append({ 'word': str(w or ''), 'start': st, 'end': en, 'prob': pr })
                except Exception:
                    prev_seq.append({ 'word': str(w or ''), 'start': None, 'end': None, 'prob': None })
            # two-pointer scan with small lookahead to find matches in order
            LOOKAHEAD = 64
            pi = 0
            enriched = []
            for w in (words or []):
                try:
                    t = str(w.get('word') or '')
                except Exception:
                    t = ''
                if t == '\n':
                    enriched.append({ 'word': '\n' })
                    continue
                # determine if current word already has usable timings/probability
                s_raw = w.get('start', None)
                e_raw = w.get('end', None)
                p_raw = w.get('probability', None)
                def _num(x):
                    try:
                        return float(x)
                    except Exception:
                        return None
                s_num = _num(s_raw)
                e_num = _num(e_raw)
                # consider timings present only when either start or end is a positive number, or end >= start and end > 0
                timings_present = ((e_num is not None and e_num > 0) or (s_num is not None and s_num > 0))
                prob_present = False
                try:
                    p_num = float(p_raw)
                    prob_present = (p_raw is not None) and (p_num == p_num)  # not NaN
                except Exception:
                    p_num = None
                    prob_present = False
                s_val = s_raw
                e_val = e_raw
                p_val = p_raw
                if not (timings_present and prob_present):
                    match_j = -1
                    limit = min(len(prev_seq), pi + LOOKAHEAD)
                    for j in range(pi, limit):
                        if str(prev_seq[j]['word'] or '') == t:
                            match_j = j
                            break
                    if match_j >= 0:
                        pi = match_j + 1
                        if not timings_present:
                            s_val = prev_seq[match_j]['start']
                            e_val = prev_seq[match_j]['end']
                        if not prob_present:
                            p_val = prev_seq[match_j]['prob']
                enriched.append({ 'word': t, **({ 'start': s_val } if s_val is not None else {}), **({ 'end': e_val } if e_val is not None else {}), **({ 'probability': p_val } if p_val is not None else {}) })
            words = enriched
            try:
                words_json = orjson.dumps(words).decode('utf-8')
            except Exception:
                pass
    except Exception:
        # If carry-over fails, fall back to client-provided words
        pass

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
        # Apply alignment updates if any
        if updates:
            db.batch_execute(
                "UPDATE transcript_words SET start_time=?, end_time=? WHERE file_path=? AND version=? AND word_index=?",
                [ (s, e, doc, int(new_version), wi) for (s,e,wi) in updates ]
            )
        # Normalize end_time to ensure non-zero durations per token
        try:
            norm_count = _normalize_end_times(db, doc, int(new_version), min_dur=0.20)
        except Exception:
            norm_count = 0

        # Store edit deltas relative to parent (if exists)
        if latest:
            d_parent = _diff(latest['text'] or '', text)
            db.execute(
                "INSERT OR REPLACE INTO transcript_edits (file_path, parent_version, child_version, dmp_patch, token_ops) VALUES (?, ?, ?, ?, ?)",
                [doc, int(latest['version']), new_version, d_parent, orjson.dumps(token_ops_block).decode('utf-8') if token_ops_block else None]
            )

        # Also store delta relative to origin (v1) for fast replay
        if latest and latest['version'] >= 1:
            v1 = _row_for_version(db, doc, 1)
            if v1:
                d_origin = _diff(v1['text'] or '', text)
                db.execute(
                    "INSERT OR REPLACE INTO transcript_edits (file_path, parent_version, child_version, dmp_patch, token_ops) VALUES (?, ?, ?, ?, ?)",
                    [doc, 1, new_version, d_origin, None]
                )

        db.commit()
        try:
            # Debug: how many tokens have timings after save
            cur = db.execute(
                "SELECT COUNT(*), SUM(CASE WHEN start_time IS NOT NULL OR end_time IS NOT NULL THEN 1 ELSE 0 END) FROM transcript_words WHERE file_path=? AND version=?",
                [doc, int(new_version)]
            )
            row = cur.fetchone() or [0, 0]
            logger.info(f"[SAVE] persisted tokens: total={int(row[0] or 0)} with_timings={int(row[1] or 0)} normalized={int(norm_count or 0)}")
        except Exception:
            pass
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
    # Debug: window stats
    try:
        nonspace = [w for w in words if not (w.get('word') or '').isspace()]
        none_timings = sum(1 for w in words if (w.get('start') is None or w.get('end') is None))
        logger.info(f"[ALIGN] window stats: tokens={len(words)} nonspace={len(nonspace)} none_timings={none_timings} clip={[clip_start, clip_end]} transcript_len={len(transcript)}")
        if words:
            logger.info(f"[ALIGN] window sample: {[ (w.get('seg'), w.get('word')) for w in words[:12] ]}")
    except Exception:
        pass

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

    # If the resolved path is a tiny pointer file, attempt to dereference to blobs/<sha>
    try:
        import re as _re
        if os.path.isfile(audio_path):
            sz0 = os.path.getsize(audio_path)
            if sz0 <= 512:
                with open(audio_path, 'rb') as _pf:
                    data = _pf.read(512)
                # try common encodings
                text = ''
                for enc in ('utf-8','utf-16','utf-16-le','utf-16-be','latin-1'):
                    try:
                        text = data.decode(enc, 'ignore').strip()
                        if text:
                            break
                    except Exception:
                        continue
                m = _re.search(r'([A-Fa-f0-9]{40,64})', text)
                if m:
                    sha = m.group(1)
                    audio_dir = current_app.config.get('AUDIO_DIR')
                    if audio_dir:
                        cand = os.path.join(audio_dir, 'blobs', sha)
                        if os.path.exists(cand):
                            audio_path = cand
    except Exception:
        pass

    # Debug: log resolved audio path and size (helps diagnose pointer stubs vs. real blobs)
    try:
        sz = os.path.getsize(audio_path) if os.path.isfile(audio_path) else -1
    except Exception:
        sz = -1
    try:
        logger.info(f"[ALIGN] doc={doc!r} ver={version} seg={seg} neighbors={neighbors} audio_path={audio_path!r} size={sz}")
    except Exception:
        pass

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
        logger.info(f"[ALIGN] ffmpeg cmd: {' '.join(cmd)}")
    except Exception:
        pass
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        wav_bytes = p.stdout
    except Exception as e:
        try:
            err = getattr(e, 'stderr', b'')
            logger.error(f"[ALIGN] ffmpeg failed for {audio_path!r}: {err.decode('utf-8','ignore')}")
        except Exception:
            pass
        return (f'ffmpeg failed: {getattr(e, "stderr", b"\"").decode("utf-8", "ignore")}', 500)

    # Call external alignment endpoint
    try:
        files = { 'audio': ('clip.wav', wav_bytes, 'audio/wav') }
        data = { 'transcript': transcript }
        r = requests.post(current_app.config.get('ALIGN_ENDPOINT', 'http://silence-remover.com:8000/align'), files=files, data=data, timeout=60)
        if not r.ok:
            return (f'align endpoint error: {r.status_code} {r.text[:200]}', 502)
        res = r.json()
        try:
            rw = (res or {}).get('words') or []
            logger.info(f"[ALIGN] align response: words={len(rw)} sample={[(x.get('word'), x.get('start'), x.get('end')) for x in rw[:10]]}")
        except Exception:
            pass
    except Exception as e:
        return (f'align request failed: {e}', 502)

    # Map response words to global times by order of non-space tokens; ensure non-zero durations
    resp_words = (res or {}).get('words') or []
    offset = ss  # our clip starts at ss; align times relative to this
    MIN_DUR = 0.20
    # Build sequences excluding whitespace-only tokens
    def _norm(s):
        try:
            return str(s or '').strip()
        except Exception:
            return ''
    old_seq = [w for w in words if _norm(w.get('word')) != '']
    resp_seq = [w or {} for w in resp_words if _norm((w or {}).get('word')) != '']
    diffs = []
    matched = 0
    updates = []  # (start_time, end_time, file_path, version, word_index)
    m = min(len(old_seq), len(resp_seq))
    for i in range(m):
        ow = old_seq[i]
        rw = resp_seq[i] or {}
        ow_text = _norm(ow.get('word'))
        old_s = float(ow.get('start') or ow.get('end') or 0.0)
        old_e = float(ow.get('end') or ow.get('start') or 0.0)
        try:
            new_s = float(rw.get('start') or 0.0) + offset
        except Exception:
            new_s = offset
        try:
            new_e = float(rw.get('end') or 0.0) + offset
        except Exception:
            new_e = new_s
        if not (new_e > new_s):
            # try next start or min duration
            next_s = None
            if (i + 1) < m:
                try:
                    next_s = float((resp_seq[i+1] or {}).get('start') or 0.0) + offset
                except Exception:
                    next_s = None
            new_e = next_s if (next_s is not None and next_s > new_s) else (new_s + MIN_DUR)
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
        matched += 1
        try:
            wi = int(ow.get('wi'))
            updates.append((new_s, new_e, doc, int(version), wi))
        except Exception:
            pass

    try:
        logger.info(f"[ALIGN] mapping: old_seq={len(old_seq)} resp={len(resp_words)} matched={matched} skipped_text_mismatch={skipped} diffs={len(diffs)}")
    except Exception:
        pass

    # Persist timing updates for matched tokens (so inserts around the window still benefit)
    if updates:
        try:
            db.execute("BEGIN TRANSACTION")
            db.batch_execute(
                "UPDATE transcript_words SET start_time=?, end_time=? WHERE file_path=? AND version=? AND word_index=?",
                updates
            )
            db.commit()
            try:
                logger.info(f"[ALIGN] timings updated: {len(updates)} tokens")
            except Exception:
                pass
        except Exception:
            db.execute("ROLLBACK")

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
        # Normalize per-segment so end >= start. If end missing/<=start, use next token's start
        # within the same segment; otherwise use start + MIN_DUR.
        MIN_DUR = 0.20
        out = []
        with_timing = 0
        cur_seg = None
        buf = []  # collect tokens for current segment

        def flush_segment(segment_tokens):
            nonlocal out, with_timing
            n = len(segment_tokens)
            # First pass: ensure numeric values
            for t in segment_tokens:
                try:
                    if t.get('start') is None:
                        t['start'] = 0.0
                    else:
                        t['start'] = float(t.get('start') or 0.0)
                except Exception:
                    t['start'] = 0.0
                try:
                    if t.get('end') is None:
                        t['end'] = float(t.get('start') or 0.0)
                    else:
                        t['end'] = float(t.get('end') or 0.0)
                except Exception:
                    t['end'] = float(t.get('start') or 0.0)
            # Second pass: lookahead normalization
            for i in range(n):
                s = float(segment_tokens[i].get('start') or 0.0)
                e = float(segment_tokens[i].get('end') or 0.0)
                if not (e > s):
                    # Try next start within segment
                    next_s = None
                    for j in range(i+1, n):
                        ns = float(segment_tokens[j].get('start') or 0.0)
                        if ns > s:
                            next_s = ns
                            break
                    if next_s is not None:
                        e = next_s
                    else:
                        e = s + MIN_DUR
                    segment_tokens[i]['end'] = e
                # accumulate timing count
                if (s > 0) or (e > 0):
                    with_timing += 1
            out.extend(segment_tokens)

        for seg, wi, word, st, en, pr in rows:
            if (cur_seg is not None) and (seg != cur_seg):
                # newline separator between segments
                if buf:
                    flush_segment(buf)
                    buf = []
                # Use the last known time from previous segment for the newline token
                try:
                    prev_end = out[-1]['end'] if out else 0.0
                except Exception:
                    prev_end = 0.0
                out.append({"word": "\n", "start": prev_end, "end": prev_end, "probability": None})
            # push current token into segment buffer
            buf.append({
                "word": word,
                "start": st if st is not None else 0.0,
                "end": en if en is not None else None,
                "probability": float(pr) if pr is not None else None,
            })
            cur_seg = seg
        # flush last segment
        if buf:
            flush_segment(buf)

        try:
            logger.info(f"[WORDS] doc={doc!r} ver={version} seg_q={seg_q!r} count_q={count_q!r} returned={len(out)} with_timing={with_timing}")
        except Exception:
            pass
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
