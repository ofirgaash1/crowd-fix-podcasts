from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
from typing import Optional

import orjson
from flask import Blueprint, current_app, jsonify, request, abort, url_for

bp = Blueprint("browser", __name__)


def _safe_str(x) -> str:
    try:
        return str(x)
    except Exception:
        return ""


@bp.route("/folders", methods=["GET"])
def list_folders():
    audio_dir: Path = current_app.config.get("AUDIO_DIR")
    if not audio_dir or not Path(audio_dir).exists():
        return jsonify([])
    items = []
    for p in sorted(Path(audio_dir).iterdir(), key=lambda x: x.name.lower()):
        if p.is_dir():
            items.append({"name": p.name, "type": "directory"})
    return jsonify(items)


@bp.route("/files", methods=["GET"])
def list_files():
    folder = request.args.get("folder", "").strip()
    if not folder:
        abort(400, "missing ?folder=")
    audio_dir: Path = current_app.config.get("AUDIO_DIR")
    base = Path(audio_dir) / folder
    if not base.exists() or not base.is_dir():
        return jsonify([])
    files = []
    for p in sorted(base.iterdir(), key=lambda x: x.name.lower()):
        if p.is_file() and p.suffix.lower() in (".opus", ".mp3", ".wav", ".m4a"):
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            files.append({"name": p.name, "type": "file", "size": size})
    return jsonify(files)


def _read_transcript_json(transcripts_dir: Path, folder: str, file_name: str) -> Optional[dict | list]:
    stem = Path(file_name).with_suffix("").name
    # Expected layout: <TRANSCRIPTS_DIR>/<folder>/<stem>/full_transcript.json.gz
    gz_path = Path(transcripts_dir) / folder / stem / "full_transcript.json.gz"
    json_path = Path(transcripts_dir) / folder / f"{stem}.json"
    if gz_path.exists():
        with gzip.open(gz_path, "rb") as fh:
            return orjson.loads(fh.read())
    if json_path.exists():
        with open(json_path, "rb") as fh:
            return orjson.loads(fh.read())
    return None


@bp.route("/episode", methods=["GET"])
def get_episode():
    folder = request.args.get("folder", "").strip()
    file_name = request.args.get("file", "").strip()
    if not folder or not file_name:
        abort(400, "missing ?folder= and/or ?file=")

    transcripts_dir: Path = current_app.config.get("TRANSCRIPTS_DIR")
    audio_dir: Path = current_app.config.get("AUDIO_DIR")
    if not transcripts_dir or not audio_dir:
        abort(500, "server misconfigured: missing TRANSCRIPTS_DIR or AUDIO_DIR")

    tr = _read_transcript_json(Path(transcripts_dir), folder, file_name)
    if tr is None:
        abort(404, "transcript not found")

    # Audio URL served by our /audio/<path> route
    # Keep relative URL so the frontend can use it directly
    audio_rel = f"/audio/{folder}/{file_name}"

    # Shape purposely minimal; frontend will normalize words/tokens
    return jsonify({
        "audioUrl": audio_rel,
        "transcript": tr
    })


@bp.after_request
def add_cors_headers(resp):
    # Allow simple cross-origin GET for local file:// development
    try:
        resp.headers.setdefault('Access-Control-Allow-Origin', '*')
        resp.headers.setdefault('Access-Control-Allow-Methods', 'GET, OPTIONS')
        resp.headers.setdefault('Access-Control-Allow-Headers', 'Content-Type')
    except Exception:
        pass
    return resp
