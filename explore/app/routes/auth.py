from flask import Blueprint, render_template, redirect, url_for, session, request, current_app
try:
    from authlib.integrations.flask_client import OAuth as AuthlibOAuth
    _HAS_AUTHLIB = True
except Exception:  # fallback
    from flask_oauthlib.client import OAuth as FlaskOAuth
    _HAS_AUTHLIB = False
import os
from functools import wraps

bp = Blueprint('auth', __name__)
oauth = None

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Skip authentication in development mode if TS_USER_EMAIL is set
        in_dev = os.environ.get('FLASK_ENV') == 'development'
        if in_dev and os.environ.get('TS_USER_EMAIL'):
            session["user_email"] = os.environ["TS_USER_EMAIL"]
            
        if "user_email" not in session:
            # Store the requested URL in session
            session['next_url'] = request.url
            return redirect(url_for("auth.login"))
        return f(*args, **kwargs)
    return decorated_function

def init_oauth(app):
    """Initialize OAuth with the Flask app (prefers Authlib)."""
    global oauth
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None
    if _HAS_AUTHLIB:
        oauth = AuthlibOAuth(app)
        google = oauth.register(
            name='google',
            client_id=client_id,
            client_secret=client_secret,
            server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
            client_kwargs={'scope': 'openid email profile'}
        )
        return google
    else:
        oauth = FlaskOAuth()
        google = oauth.remote_app(
            "google",
            consumer_key=client_id,
            consumer_secret=client_secret,
            request_token_params={"scope": "email"},
            base_url="https://www.googleapis.com/oauth2/v1/",
            request_token_url=None,
            access_token_method="POST",
            access_token_url="https://accounts.google.com/o/oauth2/token",
            authorize_url="https://accounts.google.com/o/oauth2/auth",
        )
        @google.tokengetter
        def get_google_oauth_token():
            return session.get("google_token")
        return google

@bp.route("/login")
def login():
    # Track page view
    analytics = current_app.config.get('ANALYTICS_SERVICE')
    if analytics:
        analytics.capture_event('page_viewed', {'page': 'login'})
    
    # Get Google Analytics tag from environment if available
    google_analytics_tag = os.environ.get("GOOGLE_ANALYTICS_TAG", "")
    
    return render_template("login.html", google_analytics_tag=google_analytics_tag)

@bp.route("/authorize")
def authorize():
    # Store the next URL if not already in session
    if 'next_url' not in session:
        session['next_url'] = url_for('main.home')
        
    google = current_app.extensions.get('google_oauth')
    if not google:
        return redirect(url_for('auth.login'))
    if _HAS_AUTHLIB:
        redirect_uri = url_for("auth.authorized", _external=True)
        return oauth.google.authorize_redirect(redirect_uri)
    else:
        return google.authorize(callback=url_for("auth.authorized", _external=True))

@bp.route("/login/authorized")
def authorized():
    google = current_app.extensions.get('google_oauth')
    if not google:
        return redirect(url_for('auth.login'))
    # Authlib branch
    if _HAS_AUTHLIB:
        try:
            token = oauth.google.authorize_access_token()
            # OpenID userinfo
            userinfo = oauth.google.get('userinfo').json()
            email = userinfo.get('email')
            if email:
                session['user_email'] = email
            else:
                raise RuntimeError('email missing from userinfo')
        except Exception as e:
            analytics = current_app.config.get('ANALYTICS_SERVICE')
            if analytics:
                analytics.capture_event('login_failed', {'reason': str(e)})
            return redirect(url_for('auth.login'))
    else:
        # Legacy flask-oauthlib
        resp = google.authorized_response()
        if resp is None or resp.get("access_token") is None:
            error_message = "Access denied: reason={0} error={1}".format(
                request.args.get("error_reason", "Unknown"), 
                request.args.get("error_description", "Unknown")
            )
            analytics = current_app.config.get('ANALYTICS_SERVICE')
            if analytics:
                analytics.capture_event('login_failed', {'reason': error_message})
            return redirect(url_for('auth.login'))
        session["google_token"] = (resp["access_token"], "")
        user_info = google.get("userinfo")
        session["user_email"] = user_info.data["email"]
        session.pop("google_token")
    
    # Track successful login
    analytics = current_app.config.get('ANALYTICS_SERVICE')
    if analytics:
        analytics.capture_event('login_successful', {'email': session["user_email"]})
    
    # Get the next URL from session or default to home
    next_url = session.pop('next_url', url_for('main.home'))
    
    # Redirect to the next URL
    return redirect(next_url)

@bp.route("/logout")
def logout():
    # Track logout
    analytics = current_app.config.get('ANALYTICS_SERVICE')
    if analytics and "user_email" in session:
        analytics.capture_event('logout', {'email': session["user_email"]})
    
    # Clear session
    session.pop("user_email", None)
    
    return redirect(url_for("main.home")) 
