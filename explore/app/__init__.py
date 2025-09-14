from flask import Flask
from pathlib import Path
from .services.analytics_service import AnalyticsService
import os
from flask import request
from dotenv import load_dotenv, dotenv_values 
from flask_oauthlib.client import OAuth
from .services.index import IndexManager
from .services.search import SearchService

load_dotenv() 

def create_app(data_dir: str, index_file: str = None):
    app = Flask(__name__)
    
    # Configure paths
    app.config['DATA_DIR'] = data_dir
    app.config['AUDIO_DIR'] = Path(data_dir) / "audio"
    # Transcripts (JSON/GZ) live under data/json
    app.config['TRANSCRIPTS_DIR'] = Path(data_dir) / "json"
    app.config['INDEX_FILE'] = index_file
    # Unified SQLite path under data dir (used by transcripts/confirmations)
    app.config['SQLITE_PATH'] = str(Path(data_dir) / 'explore.sqlite')
        
    # Configure PostHog
    app.config['POSTHOG_API_KEY'] = os.environ.get('POSTHOG_API_KEY', '')
    app.config['POSTHOG_HOST'] = os.environ.get('POSTHOG_HOST', 'https://app.posthog.com')
    app.config['DISABLE_ANALYTICS'] = os.environ.get('DISABLE_ANALYTICS', '').lower() in ('true', '1', 'yes')
    
    # Initialize analytics service
    analytics_service = AnalyticsService(
        api_key=app.config['POSTHOG_API_KEY'],
        host=app.config['POSTHOG_HOST'],
        disabled=app.config['DISABLE_ANALYTICS']
    )
    app.config['ANALYTICS_SERVICE'] = analytics_service
    
    app.config['MIME_TYPES'] = {'opus': 'audio/opus'}
    
    # Set secret key for session
    app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key')
   
    # Initialize Google OAuth (Authlib preferred). Enable if credentials are set, or in non-dev envs.
    from .routes.auth import init_oauth, bp as auth_bp
    google = None
    try:
        if os.environ.get('GOOGLE_CLIENT_ID') and os.environ.get('GOOGLE_CLIENT_SECRET'):
            google = init_oauth(app)
        elif os.environ.get('FLASK_ENV') != 'development':
            google = init_oauth(app)
    except Exception:
        google = None
    if google:
        app.extensions['google_oauth'] = google
 
    # Build audio index (local-only) for fast, robust resolution
    try:
        from .utils import build_audio_index
        audio_idx = build_audio_index(str(app.config['AUDIO_DIR']))
        app.config['AUDIO_INDEX'] = audio_idx
    except Exception as e:
        # Non-fatal: resolver will fall back to globbing
        app.config['AUDIO_INDEX'] = {}

    # Register blueprints
    from .routes import main, search, auth, export, audio
    from .routes import transcripts
    from .routes import browser
    from .routes import frontend as frontend_static
    app.register_blueprint(main.bp)
    app.register_blueprint(search.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(export.bp)
    app.register_blueprint(audio.bp)
    app.register_blueprint(transcripts.bp)
    app.register_blueprint(browser.bp)
    app.register_blueprint(frontend_static.bp)
    
    # Centralized CORS for API responses when needed
    allowed = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5000,null')
    try:
        allowed_set = set([o.strip() for o in allowed.split(',') if o.strip()])
    except Exception:
        allowed_set = set()
    app.config['ALLOWED_ORIGINS'] = allowed_set

    @app.after_request
    def _apply_cors(resp):
        try:
            origin = request.headers.get('Origin')
            if origin and origin in app.config.get('ALLOWED_ORIGINS', set()):
                resp.headers['Access-Control-Allow-Origin'] = origin
                resp.headers['Vary'] = (resp.headers.get('Vary', '') + ', Origin').strip(', ')
                resp.headers['Access-Control-Allow-Credentials'] = 'true'
                resp.headers.setdefault('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                resp.headers.setdefault('Access-Control-Allow-Headers', 'Content-Type')
        except Exception:
            pass
        return resp

    @app.before_request
    def _handle_preflight():
        # Respond to CORS preflight early if origin is allowed
        if request.method == 'OPTIONS':
            origin = request.headers.get('Origin')
            if origin and origin in app.config.get('ALLOWED_ORIGINS', set()):
                from flask import make_response
                resp = make_response('', 204)
                resp.headers['Access-Control-Allow-Origin'] = origin
                resp.headers['Vary'] = (resp.headers.get('Vary', '') + ', Origin').strip(', ')
                resp.headers['Access-Control-Allow-Credentials'] = 'true'
                resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
                resp.headers['Access-Control-Allow-Headers'] = request.headers.get('Access-Control-Request-Headers', 'Content-Type')
                return resp
        return None

    return app

def init_index_manager(app, file_records=None, index_file=None, force_reindex=False, **db_kwargs):
    """Initialize the index manager with the given parameters.
    
    Args:
        app: Flask application instance
        file_records: Optional list of FileRecord objects
        index_file: Optional path to index file
        force_reindex: Whether to force rebuilding the index
        **db_kwargs: Database-specific connection parameters
    """
    # Set default database parameters if not provided
    if not db_kwargs:
        db_kwargs = {
            "path": app.config.get('SQLITE_PATH', os.environ.get('SQLITE_PATH', 'explore.sqlite'))
        }
    
    if index_file:
        # Load from flat index file
        index_mgr = IndexManager(index_path=index_file, **db_kwargs)
    elif file_records:
        # Build index from files
        index_mgr = IndexManager(file_records=file_records, **db_kwargs)
    else:
        raise ValueError("Either file_records or index_file must be provided")
    
    app.config['SEARCH_SERVICE'] = SearchService(index_mgr)
    return index_mgr

def register_error_handlers(app):
    @app.errorhandler(404)
    def handle_not_found(e):
        analytics = app.config.get('ANALYTICS_SERVICE')
        if analytics:
            analytics.capture_error('not_found', str(e))
        return 'Page not found', 404
        
    @app.errorhandler(500)
    def handle_server_error(e):
        analytics = app.config.get('ANALYTICS_SERVICE')
        if analytics:
            analytics.capture_error('server_error', str(e))
        return 'Internal server error', 500 
