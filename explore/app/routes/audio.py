from flask import Blueprint, send_file, current_app, request, Response
from ..routes.auth import login_required
from ..utils import resolve_audio_path
import os
import mimetypes
import re
import time
import logging
import uuid
import glob

bp = Blueprint('audio', __name__)
logger = logging.getLogger(__name__)

def _win_long_path(p: str) -> str:
    try:
        if os.name == 'nt':
            p = os.path.abspath(p)
            if not p.startswith('\\\\?\\'):
                return '\\\\?\\' + p
    except Exception:
        pass
    return p


def send_range_file(path, request_id=None, requested_name=None):
    start_time = time.time()
    if request_id:
        logger.info(f"[TIMING] [REQ:{request_id}] Starting to send file: {path}")

    range_header = request.headers.get('Range', None)
    # Resolve a usable filesystem path by trying long-path and plain variants.
    long_variant = _win_long_path(path)
    plain_variant = os.path.abspath(path)
    fs_path = None
    for candidate in [long_variant, plain_variant]:
        try:
            with open(candidate, 'rb'):
                pass
            fs_path = candidate
            if request_id:
                logger.info(f"[TIMING] [REQ:{request_id}] Using path variant: {candidate}")
            break
        except Exception:
            continue
    if not fs_path:
        if request_id:
            logger.error(
                f"[TIMING] [REQ:{request_id}] File not found. long='{long_variant}' plain='{plain_variant}'"
            )
        return "File not found", 404

    # Determine file size using a robust method
    try:
        with open(fs_path, 'rb') as _f_sz:
            _f_sz.seek(0, os.SEEK_END)
            size = _f_sz.tell()
    except Exception:
        try:
            size = os.path.getsize(fs_path)
        except Exception:
            if request_id:
                logger.error(f"[TIMING] [REQ:{request_id}] Unable to determine file size for: {fs_path}")
            return "File not found", 404

    # If this is a tiny text pointer, follow to blob target (safety net even if resolver missed it)
    try:
        if size <= 512:
            with open(fs_path, 'rb') as _pf:
                data = _pf.read(512)
            # best-effort decodes
            for enc in ('utf-8','utf-16','utf-16-le','utf-16-be','latin-1'):
                try:
                    text = data.decode(enc, 'ignore').strip()
                except Exception:
                    text = ''
                if not text:
                    continue
                if 'blobs' in text or 'oid sha256:' in text or (len(text) >= 40 and all(ch in '0123456789abcdefABCDEF' for ch in text.strip().split('/')[-1])):
                    # Try mapping to <AUDIO_DIR>/blobs/<sha>
                    sha = None
                    import re as _re
                    m = _re.search(r'([A-Fa-f0-9]{40,64})', text)
                    if m:
                        sha = m.group(1)
                    if sha:
                        audio_dir = current_app.config.get('AUDIO_DIR')
                        if audio_dir:
                            cand = os.path.join(audio_dir, 'blobs', sha)
                            if os.path.exists(cand):
                                fs_path = cand
                                # refresh size
                                try:
                                    with open(fs_path, 'rb') as _f_sz2:
                                        _f_sz2.seek(0, os.SEEK_END)
                                        size = _f_sz2.tell()
                                except Exception:
                                    size = os.path.getsize(fs_path)
                                if request_id:
                                    logger.info(f"[TIMING] [REQ:{request_id}] Pointer file redirected to blob: {fs_path}")
                                break
            # Fallthrough: if not redirected, continue with tiny file (will be unplayable)
    except Exception:
        pass
    # Determine content type using the requested name if available (handles blob targets)
    name_for_type = requested_name or path
    content_type = mimetypes.guess_type(name_for_type)[0] or 'application/octet-stream'
    try:
        if (name_for_type or '').lower().endswith('.opus'):
            # Use a broadly compatible type for Opus-in-Ogg
            content_type = 'audio/ogg; codecs=opus'
    except Exception:
        pass

    def generate_chunks():
        chunk_size = 8192  # 8KB chunks
        with open(fs_path, 'rb') as f:
            if range_header:
                # Example Range: bytes=12345-
                byte1, byte2 = 0, None
                m = re.search(r'bytes=(\d+)-(\d*)', range_header)
                if m:
                    byte1 = int(m.group(1))
                    if m.group(2):
                        byte2 = int(m.group(2))
                if byte2 is None:
                    byte2 = size - 1
                length = byte2 - byte1 + 1
                
                if request_id:
                    logger.info(f"[TIMING] [REQ:{request_id}] Serving range request: bytes {byte1}-{byte2}/{size}")
                
                f.seek(byte1)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
            else:
                if request_id:
                    logger.info(f"[TIMING] [REQ:{request_id}] Serving full file: {size} bytes")
                
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk

    if range_header:
        m = re.search(r'bytes=(\d+)-(\d*)', range_header)
        if m:
            byte1 = int(m.group(1))
            # If client specified end, clamp to EOF; otherwise default to EOF
            if m.group(2):
                byte2 = int(m.group(2))
            else:
                byte2 = size - 1
            # Handle invalid/oversized ranges
            if byte1 >= size:
                # 416 Range Not Satisfiable
                resp = Response(status=416)
                resp.headers.add('Content-Range', f'bytes */{size}')
                return resp
            if byte2 >= size:
                byte2 = size - 1
            if byte2 < byte1:
                byte2 = byte1
            length = byte2 - byte1 + 1
            
            resp = Response(generate_chunks(), 206, mimetype=content_type)
            resp.headers.add('Content-Range', f'bytes {byte1}-{byte2}/{size}')
            resp.headers.add('Accept-Ranges', 'bytes')
            resp.headers.add('Content-Length', str(length))
            
            if request_id:
                duration_ms = (time.time() - start_time) * 1000
                logger.info(f"[TIMING] [REQ:{request_id}] Range file served in {duration_ms:.2f}ms")
            
            return resp

    # No Range: return full file
    resp = Response(generate_chunks(), 200, mimetype=content_type)
    resp.headers.add('Accept-Ranges', 'bytes')
    resp.headers.add('Content-Length', str(size))
    
    if request_id:
        duration_ms = (time.time() - start_time) * 1000
        logger.info(f"[TIMING] [REQ:{request_id}] Full file served in {duration_ms:.2f}ms")
    
    return resp

@bp.route('/audio/<path:filename>')
@login_required
def serve_audio(filename):
    request_id = str(uuid.uuid4())[:8]
    start_time = time.time()
    
    try:
        # Log the raw and repr forms to diagnose encoding issues
        logger.info(f"[TIMING] [REQ:{request_id}] Audio request received for: {filename}")
        logger.info(f"[TIMING] [REQ:{request_id}] filename.repr={repr(filename)}")
    except Exception:
        pass

    # Try to recover proper UTF-8 path from raw request URI (handles mojibake and double-encoding)
    src_candidates = []
    try:
        raw_uri = (request.environ.get('RAW_URI')
                   or request.environ.get('REQUEST_URI')
                   or (request.full_path or ''))
        if raw_uri:
            try:
                base = raw_uri.split('?', 1)[0]
                if '/audio/' in base:
                    raw_seg = base.split('/audio/', 1)[1]
                    # Generate multiple decoding variants
                    from urllib.parse import unquote, unquote_to_bytes
                    cand_texts = []
                    try:
                        cand_texts.append(unquote(raw_seg))
                        cand_texts.append(unquote(unquote(raw_seg)))
                    except Exception:
                        pass
                    try:
                        b = unquote_to_bytes(raw_seg)
                        cand_texts.append(b.decode('utf-8', 'ignore'))
                        # Sometimes browsers double-encode; try a second pass
                        cand_texts.append(unquote(b.decode('latin-1', 'ignore')))
                    except Exception:
                        pass
                    for fixed in cand_texts:
                        if fixed and fixed not in src_candidates:
                            src_candidates.append(fixed)
                    if cand_texts:
                        logger.info(f"[TIMING] [REQ:{request_id}] recovered_from_uri_variants={list(map(repr, cand_texts))}")
            except Exception:
                pass
    except Exception:
        pass

    # Add best-effort re-decode of the provided param (route variable)
    try:
        from urllib.parse import unquote, unquote_to_bytes
        # 1) Direct param
        if filename not in src_candidates:
            src_candidates.append(filename)
        # 2) Percent-decoded once/twice
        try:
            dec1 = unquote(filename)
            if dec1 and dec1 not in src_candidates:
                src_candidates.append(dec1)
            dec2 = unquote(dec1)
            if dec2 and dec2 not in src_candidates:
                src_candidates.append(dec2)
        except Exception:
            pass
        # 3) Bytes route (handles malformed % sequences)
        try:
            b = unquote_to_bytes(filename)
            u8 = b.decode('utf-8', 'ignore')
            if u8 and u8 not in src_candidates:
                src_candidates.append(u8)
        except Exception:
            pass
        # 4) latin1->utf8 fallback
        alt = filename.encode('latin-1', 'ignore').decode('utf-8', 'ignore')
        if alt and alt not in src_candidates:
            src_candidates.append(alt)
            logger.info(f"[TIMING] [REQ:{request_id}] latin1->utf8 candidate={repr(alt)}")
    except Exception:
        pass

    # Deduplicate while preserving order
    _seen = set()
    src_candidates = [x for x in src_candidates if not (x in _seen or _seen.add(x))]

    try:
        audio_path = None
        for src in src_candidates:
            audio_path = resolve_audio_path(src)
            if audio_path:
                break
        if audio_path:
            try:
                logger.info(f"[TIMING] [REQ:{request_id}] Streaming local audio: {audio_path}")
                logger.info(f"[TIMING] [REQ:{request_id}] audio_path.repr={repr(audio_path)}")
            except Exception:
                pass
            return send_range_file(audio_path, request_id, requested_name=filename)
        logger.error(f"[TIMING] [REQ:{request_id}] Local audio not found. tried={list(map(repr, src_candidates))}")
        return (f"Audio not found: {filename}", 404)
        
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"[TIMING] [REQ:{request_id}] Error serving audio file {filename}: {str(e)} after {duration_ms:.2f}ms")
        import traceback
        traceback.print_exc()
        return f"Error: {str(e)}", 404


@bp.route('/debug/audio/resolve')
def debug_audio_resolve():
    # Dev-only helper to inspect resolved path
    if os.environ.get('FLASK_ENV') != 'development':
        return ("Not available", 404)
    folder = request.args.get('folder', '').strip()
    file = request.args.get('file', '').strip()
    if not folder or not file:
        return ("missing folder/file", 400)
    src = f"{folder}/{file}"
    # Provide additional debugging info
    try:
        from ..utils import _norm_text
        decoded = _norm_text(src)
        parts = decoded.split('/') if decoded else []
        key = '/'.join([_norm_text(parts[0]), _norm_text(parts[-1])]) if len(parts) >= 2 else decoded
        idx = (current_app.config or {}).get('AUDIO_INDEX') or {}
        endswith_matches = [k for k in idx.keys() if k.endswith('/' + (parts[-1] if parts else ''))]
        direct = idx.get(key)
        raw_direct = idx.get(src)
    except Exception:
        key = src
        endswith_matches = []
        idx = {}
        direct = None
        raw_direct = None
    path = resolve_audio_path(src)
    meta = {
        "requested": src,
        "computed_key": key,
        "index_size": len(idx),
        "endswith_candidates": endswith_matches[:5],
        "resolved": path or None,
        "direct": direct or None,
        "raw_direct": raw_direct or None
    }
    try:
        probe = path or direct or raw_direct
        if probe and os.path.isfile(probe):
            sz = os.path.getsize(probe)
            meta["resolved_size"] = sz
            if sz <= 512:
                with open(probe, 'rb') as fh:
                    data = fh.read(512)
                meta["resolved_preview_hex"] = data[:64].hex()
                previews = {}
                for enc in ('utf-8','utf-16','utf-16-le','utf-16-be','latin-1'):
                    try:
                        previews[enc] = data.decode(enc, 'ignore')[:120]
                    except Exception:
                        pass
                meta["resolved_preview_text"] = previews
    except Exception:
        pass
    return (meta, 200)


@bp.route('/debug/audio/reindex', methods=['GET','POST'])
def debug_audio_reindex():
    # Dev-only reindexer
    if os.environ.get('FLASK_ENV') != 'development':
        return ("Not available", 404)
    try:
        from ..utils import build_audio_index
        audio_dir = current_app.config.get('AUDIO_DIR')
        if not audio_dir:
            return ("AUDIO_DIR not set", 500)
        idx = build_audio_index(str(audio_dir))
        current_app.config['AUDIO_INDEX'] = idx
        # Return a small sample of keys for verification
        sample = []
        try:
            for i, k in enumerate(sorted(idx.keys())):
                sample.append(k)
                if i >= 4:
                    break
        except Exception:
            pass
        return ({"count": len(idx), "sample": sample}, 200)
    except Exception as e:
        return (str(e), 500)


@bp.route('/debug/audio/scan')
def debug_audio_scan():
    # Dev-only: scan a folder's files and report resolution + sizes
    if os.environ.get('FLASK_ENV') != 'development':
        return ("Not available", 404)
    folder = request.args.get('folder', '').strip()
    if not folder:
        return ("missing folder", 400)
    try:
        from ..utils import _norm_text
        idx = (current_app.config or {}).get('AUDIO_INDEX') or {}
        # Collect files by suffix in index keys that end with this folder
        files = []
        for k in sorted(idx.keys()):
            try:
                if k.startswith(_norm_text(folder) + '/'):
                    files.append(k.split('/', 1)[1])
            except Exception:
                continue
        out = []
        for f in files:
            src = f"{folder}/{f}"
            path = resolve_audio_path(src)
            rec = { 'file': f, 'resolved': path }
            try:
                if path and os.path.isfile(path):
                    sz = os.path.getsize(path)
                    rec['size'] = sz
                    if sz <= 512:
                        with open(path, 'rb') as fh:
                            data = fh.read(256)
                        rec['preview_hex'] = data[:64].hex()
                        try:
                            text = data.decode('utf-8', 'ignore')
                        except Exception:
                            text = ''
                        rec['preview_text'] = text[:120]
            except Exception:
                pass
            out.append(rec)
        return ({ 'folder': folder, 'count': len(out), 'items': out[:200] }, 200)
    except Exception as e:
        return (str(e), 500)
