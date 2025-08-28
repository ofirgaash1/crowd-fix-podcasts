// v2/render/overlay.js

/**
 * Compute absolute text offsets per token (counting only non-deleted tokens).
 * Newlines ("\n") count as 1 char to match wordsToText() usage.
 * @param {Array<{word:string,state?:string}>} tokens
 * @returns {number[]} abs index for each token (length === tokens.length)
 */
export function computeAbsIndexMap(tokens) {
  const abs = new Array(tokens.length);
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] || {};
    abs[i] = acc;
    if (t.state !== 'del') acc += (t.word || '').length;
  }
  return abs;
}

/** internal: CSS var fetch (returns raw value) */
function getCssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** internal: probability painter (no-op when disabled or p>=threshold) */
function paintProb(el, p, enabled, threshold, rgb, baseAlpha) {
  if (!enabled || !Number.isFinite(p) || p >= threshold) {
    el.style.backgroundColor = '';
    return;
  }
  const clamped = Math.max(0, Math.min(1, p));
  const alpha = (1 - clamped) * baseAlpha; // lower prob → stronger
  el.style.backgroundColor = `rgba(${rgb}, ${alpha})`;
}

export class OverlayRenderer {
  /**
   * @param {{
   *   container?: HTMLElement,
   *   probEnabled?: boolean,
   *   probThreshold?: number,   // e.g. 0.95
   * }} opts
   */
  constructor(opts = {}) {
    this.container = opts.container || null;

    // tokens + indexing
    this.tokens = [];
    this.absIndex = []; // absolute char offsets per token (wordsToText basis)

    // visual state
    this.probEnabled = !!opts.probEnabled;
    this.probThreshold = typeof opts.probThreshold === 'number' ? opts.probThreshold : 0.95;
    this.confirmed = []; // array of {range:[s,e]}
    this.activeIndex = -1;

    // runtime
    this._spanByIndex = new Map(); // tokenIndex -> <span>
    this._probRGB = getCssVar('--prob-color', '255,235,59'); // RGB only
    const base = parseFloat(getCssVar('--prob-alpha', '0.6'));
    this._probBaseAlpha = Number.isFinite(base) ? base : 0.6;

    // windowing (virtualization)
    this.windowStart = 0;
    this.windowSize = Math.max(200, Math.min(2000, opts.windowSize || 800));
  }

  /** attach/replace the container element */
  setContainer(el) {
    this.container = el || null;
  }

  /** update tokens and (optionally) absIndex precomputed */
  setTokens(tokens, absIndex) {
    this.tokens = Array.isArray(tokens) ? tokens : [];
    this.absIndex = Array.isArray(absIndex) && absIndex.length === this.tokens.length
      ? absIndex
      : computeAbsIndexMap(this.tokens);
    this.renderAll();
  }

  /** set virtual window size in tokens */
  setWindowSize(n) {
    const v = Math.max(200, Math.min(5000, Math.floor(n || 800)));
    if (v !== this.windowSize) { this.windowSize = v; this.renderAll(); }
  }

  /** set start index for window */
  setWindowStart(i) {
    const maxStart = Math.max(0, (this.tokens?.length || 0) - 1);
    const s = Math.max(0, Math.min(maxStart, Math.floor(i || 0)));
    if (s !== this.windowStart) { this.windowStart = s; this.renderAll(); }
  }

  /** set confirmed ranges (array of {range:[start,end], ...}) */
  setConfirmedRanges(ranges) {
    this.confirmed = Array.isArray(ranges) ? ranges.slice() : [];
    this.applyConfirmedHighlights();
  }

  /** enable/disable probability tint */
  setProbEnabled(on) {
    this.probEnabled = !!on;
    this.repaintProb(); // repaint span backgrounds only
  }

  /** set prob threshold (e.g., 0.95 => paint only p<0.95) */
  setProbThreshold(v) {
    this.probThreshold = (typeof v === 'number' ? v : 0.95);
    this.repaintProb();
  }

  /** update active token index (karaoke) */
  updateActiveIndex(i) {
    if (!this.container) return;
    if (this.activeIndex === i) return;

    if (this.activeIndex >= 0) {
      const prev = this._spanByIndex.get(this.activeIndex);
      if (prev) prev.classList.remove('active', 'confirmed-active');
      // restore probability background on previously active word
      if (prev) {
        const t = this.tokens[this.activeIndex];
        const p = t && Number.isFinite(t.probability) ? +t.probability : NaN;
        paintProb(prev, p, this.probEnabled, this.probThreshold, this._probRGB, this._probBaseAlpha);
      }
    }

    this.activeIndex = i;

    if (i >= 0) {
      const el = this._spanByIndex.get(i);
      if (el) {
        el.classList.add('active');
        // suppress probability tint while active so active bg is visible
        el.style.backgroundColor = '';
        // if also confirmed → add ring
        if (el.classList.contains('confirmed')) {
          el.classList.add('confirmed-active');
        }
      }
    }
  }

  /** lightweight stats for dev HUD */
  getRenderedCount() {
    return this._spanByIndex ? this._spanByIndex.size : 0;
  }

  /** re-apply probability backgrounds across existing spans */
  repaintProb() {
    if (!this.container) return;
    for (const [ti, el] of this._spanByIndex) {
      const t = this.tokens[ti];
      if (!t) continue;
      // If active, let active background show (no prob tint)
      if (ti === this.activeIndex || el.classList.contains('active')) {
        el.style.backgroundColor = '';
        continue;
      }
      const p = Number.isFinite(t.probability) ? +t.probability : NaN;
      paintProb(el, p, this.probEnabled, this.probThreshold, this._probRGB, this._probBaseAlpha);
    }
  }

  /** re-apply confirmed class across existing spans */
  applyConfirmedHighlights() {
    if (!this.container || !this._spanByIndex.size) return;

    // ranges must be sorted for early-exit binary search
    const ranges = (this.confirmed || [])
      .map(x => x && x.range ? x.range.slice() : null)
      .filter(Boolean)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const overlaps = (s, e) => {
      // binary search to any overlapping item
      let lo = 0, hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [a, b] = ranges[mid];
        if (b <= s) lo = mid + 1;
        else if (a >= e) hi = mid - 1;
        else return true; // overlap!
      }
      return false;
    };

    for (const [ti, el] of this._spanByIndex) {
      const t = this.tokens[ti];
      if (!t || t.state === 'del' || t.word === '\n') {
        el.classList.remove('confirmed', 'confirmed-active');
        continue;
      }
      const s = this.absIndex[ti] || 0;
      const e = s + (t.word ? t.word.length : 0);
      const hit = overlaps(s, e);

      if (hit) {
        el.classList.add('confirmed');
        // if currently active, carry the ring too
        if (ti === this.activeIndex) el.classList.add('confirmed-active');
      } else {
        el.classList.remove('confirmed', 'confirmed-active');
      }
    }
  }

  /** full render (simple, non-virtualized for now) */
  renderAll() {
    if (!this.container) return;
    this._spanByIndex.clear();
    this.container.textContent = '';

    const frag = document.createDocumentFragment();
    const toks = this.tokens || [];
    const abs = this.absIndex || [];

    // Build full text once to slice pre/post quickly
    let fullText = '';
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t || t.state === 'del') continue;
      fullText += (t.word || '');
    }

    const total = toks.length;
    const start = Math.max(0, Math.min(this.windowStart, Math.max(0, total - 1)));
    const end = Math.min(total, start + this.windowSize);
    const startChar = abs[start] || 0;
    let endChar;
    if (end >= total) {
      endChar = fullText.length;
    } else {
      const tEnd = toks[end];
      // end char is before token[end], so up to its start
      endChar = abs[end] || fullText.length;
      if (!Number.isFinite(endChar)) endChar = fullText.length;
    }

    // Pre-text (non-window) as a single text node
    if (startChar > 0) frag.appendChild(document.createTextNode(fullText.slice(0, startChar)));

    // Window spans
    for (let ti = start; ti < end; ti++) {
      const t = toks[ti];
      if (!t || t.state === 'del') continue;
      if (t.word === '\n') {
        frag.appendChild(document.createTextNode('\n'));
        continue;
      }
      const sp = document.createElement('span');
      sp.className = 'word';
      sp.textContent = t.word;
      if (Number.isFinite(t.start)) sp.dataset.start = String(t.start);
      if (Number.isFinite(t.end)) sp.dataset.end = String(t.end);
      sp.dataset.ti = String(ti);
      if (Number.isFinite(t.probability)) sp.dataset.prob = String(Math.round(t.probability * 100) / 100);
      const p = Number.isFinite(t.probability) ? +t.probability : NaN;
      paintProb(sp, p, this.probEnabled, this.probThreshold, this._probRGB, this._probBaseAlpha);
      frag.appendChild(sp);
      this._spanByIndex.set(ti, sp);
    }

    // Post-text (non-window)
    if (endChar < fullText.length) frag.appendChild(document.createTextNode(fullText.slice(endChar)));

    this.container.appendChild(frag);

    // after DOM present → apply confirmed + active class
    this.applyConfirmedHighlights();
    this.updateActiveIndex(this.activeIndex);
  }
}
