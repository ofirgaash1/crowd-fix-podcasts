from flask import Blueprint, request, send_file, current_app, jsonify
import io
import csv
import subprocess
from ..services.search import SearchService
from ..services.analytics_service import track_performance
from ..utils import resolve_audio_path
from ..services.db import DatabaseService
import logging
import time
import os
import glob

logger = logging.getLogger(__name__)

bp = Blueprint('export', __name__)

@bp.route('/export/results/<query>')
@track_performance('export_csv', include_args=['query'])
def export_results_csv(query):
    start_time = time.time()
    
    # Get search service from main module
    from ..routes import main
    search_service = main.search_service
    
    # Always perform a new search to get all results
    logger.info(f"Performing new search for CSV export: {query}")
    
    # Get search hits
    hits = search_service.search(query)
    
    # Enrich hits with segment info
    all_results = []
    for hit in hits:
        seg = search_service.segment(hit)
        all_results.append({
            "episode_idx": hit.episode_idx,
            "char_offset": hit.char_offset,
            "source": search_service._index_mgr.get().get_source_by_episode_idx(hit.episode_idx),
            "segment_idx": seg.seg_idx,
            "start": seg.start_sec,
            "end": seg.end_sec,
            "text": seg.text
        })
    
    # Create CSV in memory with UTF-8 BOM for Excel compatibility
    output = io.StringIO()
    output.write('\ufeff')  # UTF-8 BOM
    writer = csv.writer(output, dialect='excel')
    writer.writerow(['Source', 'Text', 'Start Time', 'End Time'])
    
    for r in all_results:
        text = r['text'].encode('utf-8', errors='replace').decode('utf-8')
        writer.writerow([r['source'], text, r['start'], r['end']])
    
    execution_time = (time.time() - start_time) * 1000
    
    # Track export analytics
    analytics = current_app.config.get('ANALYTICS_SERVICE')
    if analytics:
        analytics.capture_export(
            export_type='csv',
            query=query,
            execution_time_ms=execution_time
        )
    
    output.seek(0)
    return send_file(
        io.BytesIO(output.getvalue().encode('utf-8')),
        mimetype='text/csv; charset=utf-8',
        as_attachment=True,
        download_name=f'search_results_{query}.csv'
    )

@bp.route('/export/segment/<source>/<path:filename>')
def export_segment(source, filename):
    start_time = float(request.args.get('start', 0))
    end_time = float(request.args.get('end', 0))
    
    if end_time <= start_time:
        return "End time must be greater than start time", 400
    
    try:
        # Resolve the audio file path
        logger.info(f"Exporting segment: {source}/{filename}")
        audio_path = resolve_audio_path(f'{source}/{filename}.opus')
        if not audio_path:
            return "Source not found", 404
        
        # Create a temporary buffer for the output
        buffer = io.BytesIO()
        
        # Build ffmpeg command for segment extraction
        # -y: overwrite output file without asking
        # -i: input file
        # -ss: start time
        # -to: end time
        # -acodec: audio codec (libmp3lame)
        # -ab: audio bitrate (192k)
        # -f: output format (mp3)
        # -: output to stdout
        cmd = [
            'ffmpeg', '-y',
            '-i', audio_path,
            '-ss', str(start_time),
            '-to', str(end_time),
            '-acodec', 'libmp3lame',
            '-ab', '64k',
            '-f', 'mp3',
            '-'
        ]
        
        # Run ffmpeg and capture output
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        
        # Read the output
        output, error = process.communicate()
        
        if process.returncode != 0:
            logger.error(f"FFmpeg error: {error.decode()}")
            return "Error processing audio", 500
            
        # Write the output to the buffer
        buffer.write(output)
        buffer.seek(0)
        
        return send_file(
            buffer,
            mimetype='audio/mpeg',
            as_attachment=True,
            download_name=f'{source}_{filename}_{start_time:.2f}-{end_time:.2f}.mp3'
        )
        
    except Exception as e:
        logger.error(f"Error exporting segment: {str(e)}")
        return f"Error: {str(e)}", 500 


# ---------------- Transcript Exports ---------------- #

def _db() -> DatabaseService:
    path = current_app.config.get('SQLITE_PATH') or 'explore.sqlite'
    return DatabaseService(path=str(path))


def _latest_row(db: DatabaseService, file_path: str):
    cur = db.execute(
        "SELECT version, base_sha256, text, words FROM transcripts WHERE file_path=? ORDER BY version DESC LIMIT 1",
        [file_path]
    )
    r = cur.fetchone()
    if not r:
        return None
    return { 'version': r[0], 'base_sha256': r[1], 'text': r[2], 'words': r[3] }


def _row_for_version(db: DatabaseService, file_path: str, version: int):
    cur = db.execute(
        "SELECT version, base_sha256, text, words FROM transcripts WHERE file_path=? AND version=?",
        [file_path, int(version)]
    )
    r = cur.fetchone()
    if not r:
        return None
    return { 'version': r[0], 'base_sha256': r[1], 'text': r[2], 'words': r[3] }


def _load_words(db: DatabaseService, doc: str, version: int):
    # Prefer normalized table
    cur = db.execute(
        """
        SELECT segment_index, word_index, word, start_time, end_time, probability
        FROM transcript_words
        WHERE file_path=? AND version=?
        ORDER BY word_index ASC
        """,
        [doc, int(version)]
    )
    rows = cur.fetchall() or []
    if rows:
        out = []
        last_seg = None
        for seg, wi, word, st, en, pr in rows:
            if last_seg is not None and seg != last_seg:
                out.append({ 'word': '\n', 'start': st or 0.0, 'end': st or 0.0, 'probability': None })
            out.append({ 'word': word, 'start': float(st) if st is not None else 0.0, 'end': float(en) if en is not None else (float(st) if st is not None else 0.0), 'probability': float(pr) if pr is not None else None })
            last_seg = seg
        return out
    # Fallback to stored JSON
    row = _row_for_version(db, doc, int(version))
    import orjson
    if row and row.get('words'):
        try:
            return orjson.loads(row['words'])
        except Exception:
            pass
    # Fallback to plain text split to a single segment
    text = (row or {}).get('text') or ''
    return ([{ 'word': text, 'start': 0.0, 'end': 0.0 }])


def _segments_from_words(words):
    segs = []
    cur = { 'words': [], 'start': None, 'end': None }
    for w in (words or []):
        if not w: continue
        if str(w.get('word') or '') == '\n':
            # close segment
            if cur['words']:
                if cur['start'] is None and cur['words']:
                    s0 = cur['words'][0].get('start')
                    cur['start'] = float(s0) if s0 is not None else 0.0
                if cur['end'] is None and cur['words']:
                    e0 = cur['words'][-1].get('end')
                    cur['end'] = float(e0) if e0 is not None else cur['start']
                cur['text'] = ''.join(t.get('word','') for t in cur['words'] if t.get('word') != '\n')
                segs.append(cur)
            cur = { 'words': [], 'start': None, 'end': None }
            continue
        cur['words'].append(w)
    if cur['words']:
        if cur['start'] is None and cur['words']:
            s0 = cur['words'][0].get('start')
            cur['start'] = float(s0) if s0 is not None else 0.0
        if cur['end'] is None and cur['words']:
            e0 = cur['words'][-1].get('end')
            cur['end'] = float(e0) if e0 is not None else cur['start']
        cur['text'] = ''.join(t.get('word','') for t in cur['words'] if t.get('word') != '\n')
        segs.append(cur)
    return segs


def _build_vtt(words):
    def fmt(t):
        ms = max(0, int(round(float(t or 0.0) * 1000)))
        h = ms // 3600000; m = (ms % 3600000) // 60000; s = (ms % 60000) // 1000; ms3 = ms % 1000
        return f"{h:02d}:{m:02d}:{s:02d}.{ms3:03d}"
    segs = _segments_from_words(words)
    lines = ['WEBVTT', '']
    for i, s in enumerate(segs):
        lines.append(str(i+1))
        lines.append(f"{fmt(s['start'])} --> {fmt(s['end'])}")
        lines.append(s.get('text',''))
        lines.append('')
    return '\n'.join(lines)


@bp.route('/export/transcript/vtt')
def export_vtt():
    doc = (request.args.get('doc') or '').strip()
    version = request.args.get('version', '').strip()
    if not doc:
        return ("missing ?doc=", 400)
    db = _db()
    row = None
    if version and version.isdigit():
        row = _row_for_version(db, doc, int(version))
    else:
        row = _latest_row(db, doc)
    if not row:
        return ("not found", 404)
    words = _load_words(db, doc, int(row['version']))
    vtt = _build_vtt(words)
    buf = io.BytesIO(vtt.encode('utf-8'))
    return send_file(buf, mimetype='text/vtt; charset=utf-8', as_attachment=True, download_name='transcript.vtt')


@bp.route('/export/transcript/csv')
def export_csv():
    doc = (request.args.get('doc') or '').strip()
    version = request.args.get('version', '').strip()
    if not doc:
        return ("missing ?doc=", 400)
    db = _db()
    row = None
    if version and version.isdigit():
        row = _row_for_version(db, doc, int(version))
    else:
        row = _latest_row(db, doc)
    if not row:
        return ("not found", 404)
    words = _load_words(db, doc, int(row['version']))
    segs = _segments_from_words(words)

    out = io.StringIO()
    out.write('\ufeff')
    w = csv.writer(out, dialect='excel')
    w.writerow(['index', 'start', 'end', 'text'])
    for i, s in enumerate(segs):
        w.writerow([i, s.get('start', 0.0), s.get('end', 0.0), s.get('text','')])
    buf = io.BytesIO(out.getvalue().encode('utf-8'))
    return send_file(buf, mimetype='text/csv; charset=utf-8', as_attachment=True, download_name='transcript.csv')


@bp.route('/export/transcript/json')
def export_json():
    doc = (request.args.get('doc') or '').strip()
    version = request.args.get('version', '').strip()
    if not doc:
        return ("missing ?doc=", 400)
    db = _db()
    row = None
    if version and version.isdigit():
        row = _row_for_version(db, doc, int(version))
    else:
        row = _latest_row(db, doc)
    if not row:
        return ("not found", 404)
    words = _load_words(db, doc, int(row['version']))
    text = ''.join((t.get('word','') for t in words if t))
    return jsonify({ 'doc': doc, 'version': int(row['version']), 'text': text, 'words': words })
