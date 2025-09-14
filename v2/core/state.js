// v2/core/state.js
// Minimal, production-grade app store with shallow-merge setState,
// specific convenience setters, and a tiny throttle helper.

const PROB_DEFAULT = (() => {
  try { return (localStorage.getItem('probHL') ?? 'on') !== 'off'; }
  catch { return true; }
})();

const INITIAL_STATE = {
  // Text & tokens
  text: '',            // latest saved text (optional; if you use it)
  liveText: '',        // contentEditable current text
  baselineText: '',    // original baseline (e.g., HF)
  baselineTokens: [],  // tokens aligned to baseline
  tokens: [],          // currently rendered tokens (aligned to liveText)

  // Versioning (if/when used)
  version: 0,
  base_sha256: '',

  // Playback
  playback: {
    currentTime: 0,
    rate: 1,
    paused: true,
  },

  // UI settings
  settings: {
    probEnabled: PROB_DEFAULT,
    probThreshold: 0.95,
  },

  // Confirmations (reattached to live text)
  confirmedRanges: [], // [{ id?, range:[s,e] }, ...]
};

export class Store {
  constructor(initial = {}) {
    this.state = { ...INITIAL_STATE, ...initial };
    this.listeners = new Set();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    // emit once with current state
    try { fn(this.state); } catch {}
    return () => this.listeners.delete(fn);
  }

  getState() { return this.state; }

  _notify(tag) {
    for (const fn of this.listeners) {
      try { fn(this.state, tag); } catch {}
    }
  }

  /**
   * Shallow merge at top-level; deep-merge for known nested branches (playback/settings).
   * This is what setupPlayerSync() expects.
   */
  setState(patch, tag = 'setState') {
    if (!patch || typeof patch !== 'object') return;

    const prev = this.state;
    const next = {
      ...prev,
      ...patch,
      playback: patch.playback ? { ...prev.playback, ...patch.playback } : prev.playback,
      settings: patch.settings ? { ...prev.settings, ...patch.settings } : prev.settings,
    };

    // avoid notifying if nothing changed by reference
    if (next === prev) return;
    this.state = next;
    this._notify(tag);
  }

  /* -------------------------
     Specific convenience APIs
     ------------------------- */

  setLiveText(text) {
    if (text === this.state.liveText) return;
    this.state = { ...this.state, liveText: String(text ?? '') };
    this._notify('liveText');
  }

  setTokens(tokens) {
    // Keep referential equality discipline
    const arr = Array.isArray(tokens) ? tokens : [];
    this.state = { ...this.state, tokens: arr };
    this._notify('tokens');
  }

  setBaseline({ text, tokens }) {
    const st = this.state;
    const next = {
      ...st,
      baselineText: String(text ?? st.baselineText ?? ''),
      baselineTokens: Array.isArray(tokens) ? tokens : (st.baselineTokens || []),
    };
    this.state = next;
    this._notify('baseline');
  }

  setProbEnabled(on) {
    const enabled = !!on;
    if (enabled === !!this.state.settings.probEnabled) return;
    this.state = {
      ...this.state,
      settings: { ...this.state.settings, probEnabled: enabled },
    };
    this._notify('settings:probEnabled');
  }

  setProbThreshold(v) {
    const val = (typeof v === 'number') ? v : this.state.settings.probThreshold;
    if (val === this.state.settings.probThreshold) return;
    this.state = {
      ...this.state,
      settings: { ...this.state.settings, probThreshold: val },
    };
    this._notify('settings:probThreshold');
  }

  setPlaybackTime(t) {
    const time = +t || 0;
    if (Math.abs(time - (this.state.playback.currentTime || 0)) <= 1e-3) return;
    this.state = {
      ...this.state,
      playback: { ...this.state.playback, currentTime: time },
    };
    this._notify('playback:time');
  }

  setPlayback(partial) {
    if (!partial) return;
    this.setState({ playback: partial }, 'playback:set');
  }

  setConfirmedRanges(ranges) {
    const arr = Array.isArray(ranges) ? ranges : [];
    this.state = { ...this.state, confirmedRanges: arr };
    this._notify('confirmedRanges');
  }
}

/* Singleton store + helpers */
export const store = new Store();

export function getState() {
  return store.getState();
}

/** Small throttle helper used by renderers */
export function makeThrottle(fn, wait = 16) {
  let last = 0, scheduled = false, lastArgs = null;
  return function throttled(...args) {
    lastArgs = args;
    if (scheduled) return;
    const now = performance.now();
    const delta = now - last;
    const fire = () => {
      scheduled = false;
      last = performance.now();
      fn.apply(this, lastArgs);
    };
    if (delta >= wait) {
      fire();
    } else {
      scheduled = true;
      setTimeout(fire, wait - delta);
    }
  };
}
