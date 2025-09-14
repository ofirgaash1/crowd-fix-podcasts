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
    trans_dir: Path = current_app.config.get("TRANSCRIPTS_DIR")

    items = []
    # Prefer local audio dir if it contains sensible folders (with audio files)
    try:
        if audio_dir and Path(audio_dir).exists():
            for p in sorted(Path(audio_dir).iterdir(), key=lambda x: x.name.lower()):
                if p.is_dir():
                    # Only include if folder contains at least one plausible audio file
                    has_audio = any(
                        (c.is_file() and c.suffix.lower() in (".opus", ".mp3", ".wav", ".m4a"))
                        for c in p.iterdir()
                    )
                    if has_audio:
                        items.append({"name": p.name, "type": "directory"})
        if items:
            return jsonify(items)
    except Exception:
        pass

    # Fallback: derive folders from transcripts structure
    try:
        if trans_dir and Path(trans_dir).exists():
            # Look for <trans_dir>/*/*/full_transcript.json.gz (1-level folders)
            seen = set()
            for p in Path(trans_dir).rglob("full_transcript.json.gz"):
                try:
                    folder = p.parent.parent.name
                    if folder:
                        seen.add(folder)
                except Exception:
                    continue
            # Also handle flat JSON
            for p in Path(trans_dir).rglob("*.json"):
                try:
                    if p.name == "full_transcript.json.gz":
                        continue
                    folder = p.parent.name
                    if folder:
                        seen.add(folder)
                except Exception:
                    continue
            items = [{"name": f, "type": "directory"} for f in sorted(seen, key=lambda x: x.lower())]
            return jsonify(items)
    except Exception:
        pass

    return jsonify([])


@bp.route("/files", methods=["GET"])
def list_files():
    folder = request.args.get("folder", "").strip()
    if not folder:
        abort(400, "missing ?folder=")
    audio_dir: Path = current_app.config.get("AUDIO_DIR")
    trans_dir: Path = current_app.config.get("TRANSCRIPTS_DIR")

    # Prefer local audio files if present
    try:
        base = Path(audio_dir) / folder if audio_dir else None
        if base and base.exists() and base.is_dir():
            files = []
            for p in sorted(base.iterdir(), key=lambda x: x.name.lower()):
                if p.is_file() and p.suffix.lower() in (".opus", ".mp3", ".wav", ".m4a"):
                    try:
                        size = p.stat().st_size
                    except Exception:
                        size = 0
                    files.append({"name": p.name, "type": "file", "size": size})
            if files:
                return jsonify(files)
    except Exception:
        pass

    # Fallback: derive file list from transcripts for the folder (assume .opus names)
    try:
        stems = set()
        if trans_dir and Path(trans_dir).exists():
            for p in Path(trans_dir).rglob("full_transcript.json.gz"):
                try:
                    if p.parent.parent.name == folder:
                        stems.add(p.parent.name)
                except Exception:
                    continue
            # Also pick up flat JSON under folder
            base_json = Path(trans_dir) / folder
            if base_json.exists():
                for p in base_json.glob("*.json"):
                    stems.add(p.stem)
        files = [{"name": f"{s}.opus", "type": "file", "size": 0} for s in sorted(stems, key=lambda x: x.lower())]
        return jsonify(files)
    except Exception:
        pass

    return jsonify([])


def _read_transcript_json(transcripts_dir: Path, folder: str, file_name: str) -> Optional[dict | list]:
    stem = Path(file_name).with_suffix("").name
    # Primary expected layout + fallbacks
    candidates = [
        Path(transcripts_dir) / folder / stem / "full_transcript.json.gz",
        # Legacy/alternate nested layout: <TRANSCRIPTS_DIR>/json/<folder>/<stem>/full_transcript.json.gz
        Path(transcripts_dir) / "json" / folder / stem / "full_transcript.json.gz",
        # Flat JSON (non-gz) fallback
        Path(transcripts_dir) / folder / f"{stem}.json",
        Path(transcripts_dir) / "json" / folder / f"{stem}.json",
    ]
    for p in candidates:
        try:
            if p.suffix == ".json" and p.exists():
                with open(p, "rb") as fh:
                    return orjson.loads(fh.read())
            if p.suffix.endswith(".gz") and p.exists():
                with gzip.open(p, "rb") as fh:
                    return orjson.loads(fh.read())
        except Exception:
            continue
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

    # Always return backend /audio path (backend will proxy remotely if needed)
    audio_url = f"/audio/{folder}/{file_name}"

    # Shape purposely minimal; frontend will normalize words/tokens
    return jsonify({
        "audioUrl": audio_url,
        "transcript": tr
    })


@bp.after_request
def add_cors_headers(resp):
    # CORS is applied centrally in app.after_request
    return resp
