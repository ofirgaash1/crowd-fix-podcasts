from __future__ import annotations

from flask import Blueprint, send_from_directory, current_app, abort
from pathlib import Path

bp = Blueprint('frontend_static', __name__)


def _v2_dir() -> Path:
    # App root is explore/app; v2 lives two levels up under repo root
    app_root = Path(current_app.root_path)
    repo_root = app_root.parent.parent
    return (repo_root / 'v2').resolve()


@bp.route('/v2')
@bp.route('/v2/')
def serve_index():
    v2 = _v2_dir()
    index = v2 / 'index.html'
    if not index.exists():
        abort(404)
    return send_from_directory(str(v2), 'index.html')


@bp.route('/v2/<path:filename>')
def serve_static(filename: str):
    v2 = _v2_dir()
    target = (v2 / filename).resolve()
    # prevent directory traversal
    if not str(target).startswith(str(v2)):
        abort(404)
    if not target.exists():
        abort(404)
    return send_from_directory(str(v2), filename)
