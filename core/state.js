// v2/core/state.js
// Single source of truth for app state (framework-agnostic, tiny pub/sub).

import { EditOp } from '../shared/protocol.js';

const LS_KEYS = Object.freeze({
  PROB_ENABLED: 'probHL',
  THEME: 'theme',
});

function readBoolOnOff(key, def = true) {
  const raw = localStorage.getItem(key);
  if (raw == null) return def;
  return String(raw) !== 'off';
}
function writeBoolOnOff(key, v) {
  localStorage.setItem(key, v ? 'on' : 'off');
}

function readTheme() {
  const saved = localStorage.getItem(LS_KEYS.THEME);
  if (saved === 'dark' || saved === 'light') return saved;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

const initialState = Object.freeze({
  // Data identity
  filePath: null,
  versionMeta: /** @type {import('../shared/protocol.js').VersionMeta|null} */ (null),

  // Canonical text & tokens for the *current* loaded version.
  text: '',
  tokens: /** @type {import('../shared/protocol.js').Token[]} */ ([]),

  // Live edit buffer (mode-less editing): we treat the contentEditable value as the source of truth,
  // and mirror it here. Workers will diff (baseline text -> current text) and produce aligned tokens.
  live: {
    text: '',
    dirty: false,              // text differs from last persisted version
    composing: false,          // IME composition in progress (do not diff mid-composition)
    lastUserEditAt: 0,         // ms timestamp of last keystroke
  },

  // Confirmations attached to the current text (reattached via anchors on load)
  confirmed: /** @type {import('../shared/protocol.js').ConfirmationRange[]} */ ([]),

  // UI settings
  settings: {
    probEnabled: readBoolOnOff(LS_KEYS.PROB_ENABLED, true),
    theme: readTheme(), // 'light' | 'dark'
  },

  // Playback + viewing
  playback: {
    currentTime: 0,
    rate: 1,
  },
  viewport: {
    width: 0,
    height: 0,
    startChar: 0,
    endChar: 0,  // used by virtualizer/overlay to limit work
  },
});

class Store {
  /** @type {typeof initialState} */
  #state = structuredClone(initialState);
  /** @type {Set<Function>} */
  #subs = new Set();

  subscribe(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }
  get() {
    return this.#state;
  }
  // low-level merge
  patch(mutator) {
    const draft = structuredClone(this.#state);
    const res = mutator(draft);
    this.#state = res || draft;
    for (const s of this.#subs) {
      try { s(this.#state); } catch { }
    }
    return this.#state;
  }

  /* =========================
     High-level actions
     ========================= */

  /** Load a fresh transcript (read-only phase). */
  loadTranscript({ filePath, versionMeta, text, tokens, confirmed }) {
    this.patch(s => {
      s.filePath = filePath;
      s.versionMeta = versionMeta || null;
      s.text = text || '';
      s.tokens = Array.isArray(tokens) ? tokens : [];
      s.confirmed = Array.isArray(confirmed) ? confirmed : [];
      s.live.text = s.text;
      s.live.dirty = false;
      s.live.composing = false;
      s.live.lastUserEditAt = 0;
      return s;
    });
  }

  /** Called by the editable view on every keystroke (debounced by the view). */
  setLiveText(newText) {
    const now = performance.now();
    this.patch(s => {
      s.live.text = String(newText ?? '');
      s.live.dirty = (s.live.text !== s.text);
      s.live.lastUserEditAt = now;
      return s;
    });
  }

  /** IME guard toggles */
  setComposing(v) {
    this.patch(s => { s.live.composing = !!v; return s; });
  }

  /** After background diff+align returns */
  applyAlignedTokens(newTokens) {
    this.patch(s => {
      s.tokens = Array.isArray(newTokens) ? newTokens : [];
      return s;
    });
  }

  /** After successful save, server returns new version meta */
  markSaved(versionMeta) {
    this.patch(s => {
      s.versionMeta = versionMeta || null;
      s.text = s.live.text;
      s.live.dirty = false;
      return s;
    });
  }

  /** Confirmations lifecycle (after fetch or after save/un-save) */
  setConfirmedRanges(ranges) {
    this.patch(s => { s.confirmed = Array.isArray(ranges) ? ranges : []; return s; });
  }

  /** Settings */
  setProbEnabled(enabled) {
    this.patch(s => { s.settings.probEnabled = !!enabled; return s; });
    writeBoolOnOff(LS_KEYS.PROB_ENABLED, !!enabled);
  }
  setTheme(mode /* 'dark'|'light' */) {
    if (mode !== 'dark' && mode !== 'light') return;
    this.patch(s => { s.settings.theme = mode; return s; });
    localStorage.setItem(LS_KEYS.THEME, mode);
    document.documentElement.dataset.theme = mode; // CSS hook
  }

  /** Playback and viewport updates (called by player/sync & virtualizer) */
  setPlaybackTime(t, rate) {
    this.patch(s => { s.playback.currentTime = +t || 0; if (rate) s.playback.rate = +rate || 1; return s; });
  }
  setViewport(vp) {
    this.patch(s => {
      s.viewport.width = vp.width ?? s.viewport.width;
      s.viewport.height = vp.height ?? s.viewport.height;
      s.viewport.startChar = vp.startChar ?? s.viewport.startChar;
      s.viewport.endChar = vp.endChar ?? s.viewport.endChar;
      return s;
    });
  }
}

// Add: tokens setter for worker alignment results
// (keep this block ABOVE the singleton export or directly above/below works too)
Store.prototype.setTokens = function (tokens) {
  const arr = Array.isArray(tokens) ? tokens : [];
  this.state.tokens = arr;
  // derive plain text from non-deleted tokens
  this.state.text = arr
    .filter(t => t && t.state !== 'del')
    .map(t => t.word || '')
    .join('');
  // notify listeners just like other setters
  if (typeof this.emit === 'function') {
    this.emit('tokens', this.state.tokens);
    this.emit('text', this.state.text);
  }
};

// Export a singleton store (simple and enough for this app).
export const store = new Store();

/* =========================
   Selectors / helpers
   ========================= */

/** Convenience accessor */
export function getState() { return store.get(); }

/** True if confirming is allowed right now (must match persisted version text). */
export function canConfirmAgainstCurrentVersion() {
  const s = store.get();
  // We’ll let the server be the source of truth, but at the UI layer we disable
  // the button if the live text differs from persisted.
  return !!s.versionMeta && !s.live.dirty;
}

/** Utility to coalesce frequent edits (view can use this). */
export function makeThrottle(fn, ms) {
  let t = 0, pending = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    const dt = performance.now() - t;
    if (dt >= ms) {
      t = performance.now();
      fn(...lastArgs);
    } else {
      pending = true;
      setTimeout(() => {
        pending = false;
        t = performance.now();
        fn(...lastArgs);
      }, ms - dt);
    }
  };
}
