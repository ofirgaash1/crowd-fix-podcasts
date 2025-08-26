// view.js
// TranscriptView: rendering + DOM wiring (no network/storage logic here).
// Works with model.js for text<->tokens and timing, and with data.js from
// the outside (the app can call .setBaseline(), .setAudioSrc(), etc.)
//
// Key goals: performance + simplicity
//  - Single contenteditable pipeline (debounced via requestIdleCallback)
//  - Myers diff (via model) on idle, not every keystroke frame
//  - One <span> per token; binary-search for playhead; throttled scrolling
//  - Optional probability shading (below threshold-only or all)
//
// Public API (summary):
//   new TranscriptView({ els, config })
//   .setBaseline(baselineTokens, initialData?)     // sets tokens & paints
//   .setPlainText(text)                            // sets text -> rebuilds
//   .getPlainText(), .getTokens(), .getData()      // state getters
//   .setAudioElement(audio)                        // wire <audio> for sync
//   .setProbEnabled(bool), .setProbThreshold(x)
//   .applyConfirmedRanges(ranges)                  // [{range:[s,e]}] char offsets
//   .on(event, fn)                                 // 'change','selection','playhead'
//   .destroy()
//
// The features/confirm module should use:
//   getPlainText(), getSelectionOffsets(), setSelectionByOffsets()
//   applyConfirmedRanges(ranges)

import {
  rebuildFromText,
  flattenToTokens,
  tokensToData,
  normalizeData,
  wordsToText,
  repairChronology,
  validateChronology,
  EPS,
  isWS,
} from './model.js';

const RAF = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (cb) => setTimeout(cb, 16);

const rIC = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (cb) => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 120);

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ---- Small DOM helpers ----
function plainText(node) {
  return (node?.innerText || '').replace(/\r/g, '');
}
function getSelectionOffsets(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const inC = (n) => n && (n === container || container.contains(n));
  if (!(inC(r.startContainer) && inC(r.endContainer))) return null;
  const probe = document.createRange();
  probe.selectNodeContents(container);
  let s = 0, e = 0;
  try { probe.setEnd(r.startContainer, r.startOffset); s = probe.toString().length; } catch {}
  try { probe.setEnd(r.endContainer, r.endOffset); e = probe.toString().length; } catch {}
  return [Math.min(s, e), Math.max(s, e)];
}
function setSelectionByOffsets(container, start, end) {
  const text = plainText(container);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const S = clamp(start || 0, 0, text.length);
  const E = clamp((end == null ? S : end), 0, text.length);
  const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let pos = 0, n, sNode = container, sOff = 0, eNode = container, eOff = 0;
  while ((n = tw.nextNode())) {
    const len = n.nodeValue.length;
    if (pos + len >= S && sNode === container) { sNode = n; sOff = S - pos; }
    if (pos + len >= E) { eNode = n; eOff = E - pos; break; }
    pos += len;
  }
  const sel = window.getSelection();
  const rng = document.createRange();
  try { rng.setStart(sNode, sOff); rng.setEnd(eNode, eOff); } catch { return; }
  sel.removeAllRanges(); sel.addRange(rng);
}

// ---- Binary search over start times ----
function bsearchLE(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ---- Throttle scrollIntoView: only if outside padded viewport ----
function ensureIntoView(el, padding = 40) {
  const r = el.getBoundingClientRect();
  const vpTop = 0 + padding;
  const vpBot = (document.documentElement.clientHeight || window.innerHeight) - padding;
  if (r.top < vpTop || r.bottom > vpBot) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

// ----------------------------------------------------------------------------

export class TranscriptView {
  /**
   * @param {{
   *   els: {
   *     transcript: HTMLElement,
   *     rate?: HTMLInputElement,
   *     rateVal?: HTMLElement,
   *     probToggle?: HTMLElement,
   *   },
   *   config?: {
   *     probThreshold?: number,             // default 0.95
   *     probEnabled?: boolean,              // default true
   *     probBelowThresholdOnly?: boolean,   // default true (perf optimization)
   *   }
   * }} options
   */
  constructor({ els, config = {} }) {
    this.els = els;
    this.config = {
      probThreshold: config.probThreshold ?? 0.95,
      probEnabled: config.probEnabled ?? true,
      probBelowThresholdOnly: config.probBelowThresholdOnly ?? true,
    };

    /** @type {Array<{word:string,start:number,end:number,state:'keep'|'del'|'ins',probability:number}>} */
    this.baselineTokens = [];
    this.tokens = [];
    this.data = { text: '', segments: [] };

    // rendering caches
    this.wordEls = [];
    this.starts = [];
    this.ends = [];
    this.absStarts = []; // absolute char offsets per token (non-deleted, excluding '\n')
    this.absEnds = [];
    this._lastIdx = -1;

    // selection & scheduling
    this._composing = false;
    this._pendingSel = null;
    this._idleId = 0;
    this._rafId = 0;
    this._playRAF = 0;

    // listeners
    this._listeners = { change: [], selection: [], playhead: [] };

    // audio
    this.audio = null;

    // init DOM wiring
    this.#setupEditable();
    this.#setupRate();
    this.#setupProbToggle();
  }

  // ----------------------------- public API --------------------------------

  setAudioElement(audioEl) {
    if (this.audio === audioEl) return;
    if (this.audio) this.#unbindAudio();
    this.audio = audioEl || null;
    if (this.audio) this.#bindAudio();
  }

  /**
   * Provide baseline tokens (from HF or corrected), optionally full data to seed.
   * Paints the transcript.
   */
  setBaseline(baselineTokens, initialData = null) {
    this.baselineTokens = Array.isArray(baselineTokens) ? baselineTokens.slice() : [];
    if (initialData) {
      const norm = normalizeData(initialData);
      // If caller supplies segments, respect them; else derive from tokens
      this.tokens = flattenToTokens(norm).map(t => ({ ...t, state: 'keep' }));
      this.data = tokensToData(this.tokens);
    } else {
      this.tokens = this.baselineTokens.map(t => ({ ...t, state: 'keep' }));
      this.data = tokensToData(this.tokens);
    }
    this.#renderAll();
    this.#emit('change', { tokens: this.tokens, data: this.data });
  }

  /**
   * Programmatic text set (e.g. external paste), rebuilds model on idle.
   */
  setPlainText(text) {
    if (!this.els.transcript) return;
    this.els.transcript.textContent = String(text ?? '');
    this.#scheduleRebuild(0);
  }

  getPlainText() { return this.data?.text || wordsToText(this.tokens); }
  getTokens() { return this.tokens; }
  getData() { return this.data; }

  setProbEnabled(v) {
    this.config.probEnabled = !!v;
    this.#applyProbHighlights();
  }
  setProbThreshold(v) {
    this.config.probThreshold = +v || 0.95;
    this.#applyProbHighlights();
  }

  /**
   * Apply "confirmed" overlays from ranges in absolute character offsets.
   * ranges: Array<{ range:[start,end] }>
   */
  applyConfirmedRanges(ranges) {
    const rs = Array.isArray(ranges) ? ranges.slice() : [];
    // Clear
    for (const el of this.wordEls) el.classList.remove('confirmed', 'confirmed-active');

    // Map token spans to char spans
    const charStartForTok = [];
    let acc = 0;
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      charStartForTok[i] = acc;
      if (t.state !== 'del' && t.word !== '\n') acc += (t.word || '').length;
    }

    for (let i = 0; i < this.wordEls.length; i++) {
      const el = this.wordEls[i];
      const ti = +el.dataset.ti;
      const t = this.tokens[ti];
      if (!t || t.state === 'del' || t.word === '\n') continue;
      const s = charStartForTok[ti];
      const e = s + (t.word || '').length;
      const hit = rs.some(({ range: [a, b] }) => !(e <= a || s >= b));
      if (hit) el.classList.add('confirmed');
    }
  }

  /** selection helpers for features/confirm */
  getSelectionOffsets() { return getSelectionOffsets(this.#root()); }
  setSelectionByOffsets(s, e) { setSelectionByOffsets(this.#root(), s, e); }

  on(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
    return () => {
      const arr = this._listeners[evt] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  destroy() {
    this.#unbindAudio();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._playRAF) cancelAnimationFrame(this._playRAF);
    // remove DOM listeners we attached
    const tr = this.#root();
    if (tr) {
      tr.removeEventListener('beforeinput', this._onBeforeInput, true);
      tr.removeEventListener('compositionstart', this._onCompStart, true);
      tr.removeEventListener('compositionend', this._onCompEnd, true);
      tr.removeEventListener('input', this._onInput, true);
      tr.removeEventListener('mouseup', this._onMouseUp, true);
      tr.removeEventListener('keyup', this._onKeyUp, true);
      tr.removeEventListener('click', this._onAltClick, true);
      tr.removeEventListener('contextmenu', this._onSeekContext, true);
      tr.removeAttribute('contenteditable');
    }
  }

  // ------------------------------ internals ---------------------------------

  #root() { return this.els.transcript; }

  #emit(evt, payload) {
    for (const fn of this._listeners[evt] || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  #setupEditable() {
    const tr = this.#root();
    if (!tr) return;

    // contenteditable plaintext-only if available
    try { tr.setAttribute('contenteditable', 'plaintext-only'); }
    catch { tr.setAttribute('contenteditable', 'true'); }
    tr.style.caretColor = 'var(--accent, #00a)';

    // bind handlers (bound once)
    this._onBeforeInput = () => {
      const sel = getSelectionOffsets(tr);
      this._pendingSel = sel ? sel[0] : null;
    };
    this._onCompStart = () => { this._composing = true; };
    this._onCompEnd = () => {
      this._composing = false;
      this.#scheduleRebuild(0);
    };
    this._onInput = () => {
      if (this._composing) return;
      this.#scheduleRebuild(180);
    };
    this._onMouseUp = () => this.#emit('selection', this.getSelectionOffsets());
    this._onKeyUp = () => this.#emit('selection', this.getSelectionOffsets());

    tr.addEventListener('beforeinput', this._onBeforeInput, true);
    tr.addEventListener('compositionstart', this._onCompStart, true);
    tr.addEventListener('compositionend', this._onCompEnd, true);
    tr.addEventListener('input', this._onInput, true);
    tr.addEventListener('mouseup', this._onMouseUp, true);
    tr.addEventListener('keyup', this._onKeyUp, true);

    // seek on Alt+click; keep context menu available unless user right-clicks a word
    this._onAltClick = (e) => {
      if (!this.audio) return;
      if (!e.altKey) return;
      const el = e.target.closest?.('.word');
      if (!el) return;
      const t = +el.dataset.start;
      if (Number.isFinite(t)) {
        this.audio.currentTime = t + 0.01;
        this.audio.play().catch(() => {});
        e.preventDefault();
      }
    };
    tr.addEventListener('click', this._onAltClick, true);

    this._onSeekContext = (e) => {
      const el = e.target.closest?.('.word');
      if (!el) return;
      const t = +el.dataset.start;
      if (Number.isFinite(t)) {
        this.audio && (this.audio.currentTime = t + 0.01);
        e.preventDefault(); // same behavior as original; adjust if you want native menu
      }
    };
    tr.addEventListener('contextmenu', this._onSeekContext, true);
  }

  #setupRate() {
    const rate = this.els.rate, rateVal = this.els.rateVal;
    if (!rate || !this.audio) return;
    const syncUI = () => { if (rateVal) rateVal.textContent = '×' + (this.audio.playbackRate || 1).toFixed(2); };
    this.audio.addEventListener('ratechange', syncUI);
    rate.oninput = () => {
      const v = parseFloat(rate.value) || 1;
      if (this.audio) this.audio.playbackRate = v;
      syncUI();
    };
    syncUI();
  }

  #setupProbToggle() {
    const btn = this.els.probToggle;
    if (!btn) return;
    const setUI = () => {
      btn.setAttribute('aria-pressed', String(this.config.probEnabled));
      btn.textContent = this.config.probEnabled ? 'בטל הדגשה' : 'הדגש ודאות נמוכה';
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.config.probEnabled = !this.config.probEnabled;
      setUI();
      this.#applyProbHighlights();
    }, { capture: true });
    setUI();
  }

  #scheduleRebuild(delayMs) {
    if (!this.baselineTokens.length) return;
    if (this._idleId) { cancelIdleCallback?.(this._idleId); this._idleId = 0; }
    const run = () => this.#rebuildFromDOM();
    if (delayMs <= 0) {
      rIC(run);
    } else {
      setTimeout(() => rIC(run), delayMs);
    }
  }

  #rebuildFromDOM() {
    const tr = this.#root();
    if (!tr) return;
    const txt = plainText(tr);
    // Fast path: reuse baseline if identical
    const baselineText = wordsToText(this.baselineTokens);
    const same = (txt === baselineText);
    let tokens, data;
    if (same) {
      tokens = this.baselineTokens.map(t => ({ ...t, state: 'keep' }));
      repairChronology(tokens);
      data = tokensToData(tokens);
    } else {
      ({ tokens, data } = rebuildFromText(this.baselineTokens, txt));
    }
    this.tokens = tokens;
    this.data = data;
    this.#renderAll();

    // restore caret if we captured it
    const sel = this._pendingSel;
    if (sel != null) {
      try { setSelectionByOffsets(tr, sel, sel); } catch {}
      this._pendingSel = null;
    }

    this.#emit('change', { tokens: this.tokens, data: this.data });
  }

  #clearTranscript() {
    const root = this.#root();
    if (!root) return;
    root.textContent = '';
    this.wordEls = [];
    this.starts = [];
    this.ends = [];
    this.absStarts = [];
    this.absEnds = [];
    this._lastIdx = -1;
  }

  #renderAll() {
    if (!this.#root()) return;
    this.#clearTranscript();

    const f = document.createDocumentFragment();
    let absCursor = 0;

    const shouldStoreProb =
      !this.config.probBelowThresholdOnly || this.config.probThreshold == null
        ? () => true
        : (p) => Number.isFinite(p) && p < this.config.probThreshold;

    this.tokens.forEach((t, ti) => {
      if (t.state === 'del') return;
      if (t.word === '\n') {
        f.appendChild(document.createTextNode('\n'));
        absCursor += 1;
        return;
      }
      const sp = document.createElement('span');
      sp.className = 'word';
      sp.textContent = t.word;
      sp.dataset.start = t.start;
      sp.dataset.end = t.end;
      sp.dataset.ti = String(ti);

      if (Number.isFinite(t.probability)) {
        // perf optimization: only store prob if below threshold (most tokens are >0.95)
        if (!this.config.probBelowThresholdOnly || t.probability < this.config.probThreshold) {
          sp.dataset.prob = (+t.probability).toFixed(3);
        }
      }

      f.appendChild(sp);
      this.wordEls.push(sp);
      this.starts.push(t.start);
      this.ends.push(t.end);

      const len = (t.word || '').length;
      this.absStarts.push(absCursor);
      absCursor += len;
      this.absEnds.push(absCursor);
    });

    this.#root().appendChild(f);
    this.#applyProbHighlights();
  }

  #applyProbHighlights() {
    // Implements CSS-driven alpha: el.style.setProperty('--prob-a', ...)
    const baseAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prob-alpha')) || 0.6;
    const thr = +this.config.probThreshold || 0.95;

    for (const el of this.wordEls) {
      const p = Number.parseFloat(el.dataset.prob);
      let a = 0;
      if (this.config.probEnabled && Number.isFinite(p) && p < thr) {
        a = clamp01((1 - p) * baseAlpha);
      }
      if (el.classList.contains('active')) a = 0;
      el.style.setProperty('--prob-a', String(+a.toFixed(2)));
      // background set via CSS using --prob-a
      el.style.backgroundColor = ''; // leave to CSS, keeps paint cheaper
    }
  }

  // ---------------------------- audio sync tick -----------------------------

  #bindAudio() {
    if (!this.audio) return;
    const loop = () => {
      this._playRAF = RAF(loop);
      if (!this.audio || this.audio.paused || this.audio.ended) return;

      const t = this.audio.currentTime;
      if (!this.starts.length) return;

      // find candidate by start time
      let i = bsearchLE(this.starts, t);
      if (i < 0) i = 0;

      // check containment; if miss, probe neighbor
      const inI = (t >= this.starts[i] - EPS && t <= this.ends[i] + EPS);
      if (!inI) {
        const next = i + (t > this.ends[i] ? 1 : -1);
        if (next >= 0 && next < this.starts.length) {
          const inNext = (t >= this.starts[next] - EPS && t <= this.ends[next] + EPS);
          if (inNext) i = next;
        }
      }

      if (i !== this._lastIdx) {
        if (this._lastIdx >= 0) {
          const prevEl = this.wordEls[this._lastIdx];
          if (prevEl) {
            prevEl.classList.remove('active', 'confirmed-active');
            const pPrev = parseFloat(prevEl.dataset.prob);
            const baseAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prob-alpha')) || 0.6;
            let aPrev = 0;
            if (this.config.probEnabled && Number.isFinite(pPrev) && pPrev < this.config.probThreshold) {
              aPrev = clamp01((1 - pPrev) * baseAlpha);
            }
            prevEl.style.setProperty('--prob-a', String(+aPrev.toFixed(2)));
          }
        }
        const el = this.wordEls[i];
        if (el) {
          el.classList.add('active');
          if (el.classList.contains('confirmed')) el.classList.add('confirmed-active');
          el.style.setProperty('--prob-a', '0');
          ensureIntoView(el, 72);
        }
        this._lastIdx = i;
        this.#emit('playhead', { index: i, time: t });
      }
    };
    this._playRAF = RAF(loop);

    // rate UI may be attached
    this.#setupRate();
  }

  #unbindAudio() {
    if (this._playRAF) cancelAnimationFrame(this._playRAF);
    this._playRAF = 0;
  }
}
