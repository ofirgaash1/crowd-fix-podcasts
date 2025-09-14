import os
from urllib.parse import unquote
from typing import Optional, List, Dict
import unicodedata
from flask import current_app
from pathlib import Path
from dataclasses import dataclass
from typing import NamedTuple
import gzip
import orjson
import logging

_JSON_FILENAME = "full_transcript.json.gz"          # gzipped transcripts


class FileRecord(NamedTuple):
    id: str
    json_path: Path

    def read_json(self) -> dict | list:
        """Read and parse the gzipped JSON file."""
        with gzip.open(self.json_path, 'rb') as fh:
            return orjson.loads(fh.read())


def get_transcripts(root: Path) -> List[FileRecord]:
    """Find all full_transcript.json.gz files and return a records list.
    
    Args:
        root: Root directory to search for transcript files
        
    Returns:
        List of FileRecord objects, one per transcript JSON file
        
    Supports both legacy flat files:   <id>.json.gz
    and new nested files:            <source>/<id>/full_transcript.json.gz
    """
    recs: list[FileRecord] = []
    for p in root.rglob(f"*{_JSON_FILENAME}"):
        rec_id = f"{p.parent.parent.name}/{p.parent.name}"
        recs.append(FileRecord(rec_id, p))

    # complain loudly if we picked up duplicates
    seen: set[str] = set()
    dups: set[str] = set()
    for r in recs:
        if r.id in seen:
            dups.add(r.id)
        seen.add(r.id)
    if dups:
        logging.warning("get_transcripts: duplicate IDs detected: %s", ", ".join(sorted(dups)))

    recs.sort(key=lambda r: r.id)
    return recs


def _norm_text(s: str) -> str:
    try:
        s = unicodedata.normalize('NFC', s or '')
        # Remove most control/format characters (e.g., bidi/zero-width)
        s = ''.join(ch for ch in s if unicodedata.category(ch) not in ('Cf','Cc'))
        # Normalize whitespace
        s = ' '.join(s.split())
        return s
    except Exception:
        return s or ''


def resolve_audio_path(source: str) -> Optional[str]:
    """
    Resolve a local audio path for a requested `<folder>/<file>.opus`.

    Supported layouts (local-only):
      1) <AUDIO_DIR>/<folder>/<file>.opus
      2) <AUDIO_DIR>/audio/<folder>/<hash>/<folder>/<file>.opus
    """
    audio_dir = current_app.config.get('AUDIO_DIR')
    if not audio_dir:
        return None
    # Normalize and URL-decode
    decoded = _norm_text(unquote(source or '').strip().strip('/'))
    rel = decoded.split('/') if decoded else []
    # Fast path: use prebuilt index if present
    def _resolve_link_if_needed(p: str) -> str | None:
        try:
            if os.path.islink(p):
                target = os.readlink(p)
                cand = os.path.normpath(os.path.join(os.path.dirname(p), target))
                if os.path.exists(cand):
                    return cand
                sha = os.path.basename(target)
                blob = os.path.join(audio_dir, 'blobs', sha)
                if os.path.exists(blob):
                    return blob
        except Exception:
            pass
        return p if os.path.exists(p) else None

    try:
        idx: Dict[str, str] = (current_app.config or {}).get('AUDIO_INDEX') or {}
        if idx:
            key = '/'.join([_norm_text(rel[0]), _norm_text(rel[-1])]) if len(rel) >= 2 else _norm_text(decoded)
            p = idx.get(key)
            if p:
                rp = _resolve_link_if_needed(p)
                if rp:
                    # If entry is a small pointer file, follow to blob target
                    try:
                        ptr = None
                        if os.path.isfile(rp):
                            ptr = _maybe_pointer_to_blob(rp)
                        if ptr:
                            return ptr
                    except Exception:
                        pass
                    return rp
            # Fallback: match by filename only if unique
            try:
                fname_norm = _norm_text(rel[-1]) if rel else ''
                # 1) endswith normalized filename
                if fname_norm:
                    c_keys = [k for k in idx.keys() if k.endswith('/' + fname_norm)]
                    if len(c_keys) == 1:
                        p = idx.get(c_keys[0])
                        if p:
                            rp = _resolve_link_if_needed(p)
                            if rp:
                                try:
                                    ptr = None
                                    if os.path.isfile(rp):
                                        ptr = _maybe_pointer_to_blob(rp)
                                    if ptr:
                                        return ptr
                                except Exception:
                                    pass
                                return rp
                # 2) endswith raw (pre-normalized) filename from source
                fname_raw = rel[-1] if rel else ''
                if fname_raw and fname_raw != fname_norm:
                    c_raw = [k for k in idx.keys() if k.endswith('/' + fname_raw)]
                    if len(c_raw) == 1:
                        p = idx.get(c_raw[0])
                        if p:
                            rp = _resolve_link_if_needed(p)
                            if rp:
                                try:
                                    ptr = None
                                    if os.path.isfile(rp):
                                        ptr = _maybe_pointer_to_blob(rp)
                                    if ptr:
                                        return ptr
                                except Exception:
                                    pass
                                return rp
                # 3) compare filename sans extension (case-insensitive)
                import os as _os
                base = _os.path.splitext(fname_norm)[0].lower()
                c2_keys = [k for k in idx.keys() if _os.path.splitext(k.split('/')[-1])[0].lower() == base]
                if len(c2_keys) == 1:
                    p = idx.get(c2_keys[0])
                    if p:
                        rp = _resolve_link_if_needed(p)
                        if rp:
                            return rp
            except Exception:
                pass
    except Exception:
        pass

    def _maybe_pointer_to_blob(p: str) -> Optional[str]:
        try:
            # If file is very small and text-like, it may be a pointer to a blob path or SHA
            if not os.path.isfile(p):
                return None
            if os.path.getsize(p) > 256:
                return None
            with open(p, 'rb') as fh:
                data = fh.read(512)
            # Try multiple decodings: utf-8, utf-16-le/be
            decodings = ['utf-8', 'utf-16', 'utf-16-le', 'utf-16-be', 'latin-1']
            text = ''
            for enc in decodings:
                try:
                    text = data.decode(enc, 'ignore').strip()
                    if text:
                        break
                except Exception:
                    continue
            if not text:
                return None
            # Case 1: contains explicit blobs path (relative)
            if 'blobs' in text:
                cand = os.path.normpath(os.path.join(os.path.dirname(p), text))
                if os.path.exists(cand):
                    return cand
                # Also try under <audio_dir>/blobs/<sha>
                try:
                    sha = os.path.basename(text)
                    cand2 = os.path.join(audio_dir, 'blobs', sha)
                    if os.path.exists(cand2):
                        return cand2
                except Exception:
                    pass
            # Case 2: Git LFS pointer (spec v1)
            if 'git-lfs' in text or 'oid sha256:' in text:
                try:
                    import re as _re
                    m = _re.search(r'oid\s+sha256:([A-Fa-f0-9]{40,64})', text)
                    if m:
                        sha = m.group(1)
                        cand = os.path.join(audio_dir, 'blobs', sha)
                        if os.path.exists(cand):
                            return cand
                except Exception:
                    pass
            # Case 3: looks like a bare SHA (40-64 hex)
            import re as _re
            if _re.fullmatch(r'[A-Fa-f0-9]{40,64}', text):
                cand3 = os.path.join(audio_dir, 'blobs', text)
                if os.path.exists(cand3):
                    return cand3
        except Exception:
            return None
        return None

    # 1) Direct layout: <audio_dir>/<folder>/<file>
    if rel:
        p1 = os.path.join(audio_dir, *rel)
        if os.path.exists(p1):
            # Resolve symlinks or broken relative targets (e.g., to blobs)
            try:
                if os.path.islink(p1):
                    target = os.readlink(p1)
                    # Resolve relative to the link location
                    candidate = os.path.normpath(os.path.join(os.path.dirname(p1), target))
                    if os.path.exists(candidate):
                        return candidate
                    # Common case: link points to ../../../blobs/<sha>
                    sha = os.path.basename(target)
                    blob = os.path.join(audio_dir, 'blobs', sha)
                    if os.path.exists(blob):
                        return blob
                # Not a link or already exists; check for pointer file
                ptr = _maybe_pointer_to_blob(p1)
                if ptr:
                    return ptr
                return p1 if os.path.isfile(p1) else None
            except Exception:
                # Fall through to recursive search
                pass
    # 2) Recursive search under either <audio_dir> or <audio_dir>/audio for .../<folder>/<file>
    if len(rel) >= 2:
        folder = rel[0]
        file_name = rel[-1]
        import glob
        roots = [audio_dir, os.path.join(audio_dir, 'audio')]
        for root in roots:
            pattern = os.path.join(root, '**', folder, file_name)
            for m in glob.glob(pattern, recursive=True):
                try:
                    if os.path.islink(m):
                        target = os.readlink(m)
                        cand = os.path.normpath(os.path.join(os.path.dirname(m), target))
                        if os.path.exists(cand):
                            return cand
                        sha = os.path.basename(target)
                        blob = os.path.join(audio_dir, 'blobs', sha)
                    if os.path.exists(blob):
                        return blob
                    # Pointer file fallback
                    ptr = _maybe_pointer_to_blob(m)
                    if ptr:
                        return ptr
                    if os.path.isfile(m):
                        return m
                except Exception:
                    continue
    return None


def build_audio_index(audio_dir: str) -> Dict[str, str]:
    """
    Build a mapping of "<folder>/<file>" -> absolute path for local audio.
    Supports:
      - <audio_dir>/<folder>/*.opus
      - <audio_dir>/audio/<folder>/*/<folder>/*.opus
    """
    out: Dict[str, str] = {}
    try:
        import glob
        # 1) Flat layout: <audio_dir>/<folder>/*.opus
        for p in glob.glob(os.path.join(audio_dir, '*', '*.opus')):
            folder = _norm_text(os.path.basename(os.path.dirname(p)))
            fn = _norm_text(os.path.basename(p))
            out[f"{folder}/{fn}"] = os.path.abspath(p)

        # 2) Any nested layout ending with .../<folder>/*.opus under audio_dir
        for p in glob.glob(os.path.join(audio_dir, '**', '*.opus'), recursive=True):
            parts = os.path.normpath(p).split(os.sep)
            if len(parts) >= 2:
                folder = _norm_text(parts[-2])
                fn = _norm_text(parts[-1])
                out[f"{folder}/{fn}"] = os.path.abspath(p)
    except Exception:
        pass
    return out
