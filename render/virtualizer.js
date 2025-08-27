// v2/render/virtualizer.js
// Incremental, subscription-based renderer for tokens.
// Renders in safe chunks to avoid long tasks; highlights prob + active word.

import { store, getState, makeThrottle } from '../core/state.js';
import { paintProbability, setActive /* setConfirmed (later) */ } from './overlay.js';

const CHUNK_SIZE = 500;          // how many tokens per micro-batch
const MAX_RAF_MS = 12;           // per frame budget (approx)
const ACTIVE_CLASS = 'active';   // CSS class already in your stylesheet

export class TranscriptView {
  /**
   * @param {HTMLElement} rootEl - container to render into (e.g., #transcript)
   */
  constructor(rootEl) {
    if (!rootEl) throw new Error('TranscriptView: rootEl is required');
    this.root = rootEl;

    // Local caches to avoid reflows:
    this.wordEls = [];     // spans parallel to tokens (excluding '\n')
    this.starts = [];      // start times for clickable/active scan
    this.ends = [];        // end times
    this.lastActive = -1;  // last active index

    // Subscriptions
    this.unsub = store.subscribe(this.#onStateChange.bind(this));
    // First paint
    this.#renderAllTokensIncremental(getState());

    // Listen for clicks to request seek
    this.root.addEventListener('click', (e) => {
      const span = e.target.closest('span.word');
      if (!span) return;
      const t = parseFloat(span.dataset.start);
      if (!Number.isFinite(t)) return;
      // Let host player decide what to do
      this.root.dispatchEvent(new CustomEvent('v2:seek', { detail: { time: t } }));
    }, { passive: true });
  }

  destroy() {
    this.unsub?.();
    this.unsub = null;
    this.root.textContent = '';
    this.wordEls = [];
    this.starts = [];
    this.ends = [];
  }

  /* =========================
     Store subscription
     ========================= */

  #onStateChange = makeThrottle((state) => {
    // If tokens array identity changed → rebuild DOM (incremental).
    if (this.#needsFullRebuild(state)) {
      this.#renderAllTokensIncremental(state);
      return;
    }

    // Otherwise, light updates:
    this.#repaintProbabilities(state);
    this.#updateActiveWord(state);
    // (Confirmed overlay will come later once confirmation reattach is wired in v2)
  }, 16); // throttle state bursts to ~60fps

  #needsFullRebuild(state) {
    // We keep a weak identity check: if lengths differ or we lost our spans, rebuild.
    const tokenCount = (state.tokens?.length || 0);
    const spanCount = this.wordEls.length + this.#countNewlines(state.tokens);
    if (tokenCount !== (state.tokens?.length || 0)) return true;
    if (this.root.childNodes.length === 0 && tokenCount > 0) return true;
    // If live text changed and new aligned tokens arrived (array identity will differ) — but the store
    // already triggered this path earlier. For safety: rebuild if counts diverge.
    return (spanCount === 0 && tokenCount > 0);
  }

  #countNewlines(tokens) {
    if (!Array.isArray(tokens)) return 0;
    let n = 0;
    for (const t of tokens) if (t.word === '\n') n++;
    return n;
  }

  /* =========================
     Rendering
     ========================= */

  #renderAllTokensIncremental(state) {
    // Reset DOM
    this.root.textContent = '';
    this.wordEls = [];
    this.starts = [];
    this.ends = [];
    this.lastActive = -1;

    const tokens = state.tokens || [];
    let i = 0;
    const root = this.root;

    const step = (deadline) => {
      const frag = document.createDocumentFragment();
      let produced = 0;
      const startBudget = performance.now();

      while (i < tokens.length) {
        const t = tokens[i++];
        if (t.word === '\n') {
          frag.appendChild(document.createTextNode('\n'));
        } else {
          const sp = document.createElement('span');
          sp.className = 'word';
          sp.textContent = t.word;
          sp.dataset.start = String(t.start ?? 0);
          sp.dataset.end = String(t.end ?? (t.start ?? 0));
          // Store limited precision prob on DOM
          if (Number.isFinite(t.probability)) {
            sp.dataset.prob = (Math.round(t.probability * 100) / 100).toFixed(2);
          }
          frag.appendChild(sp);
          this.wordEls.push(sp);
          this.starts.push(+t.start || 0);
          this.ends.push(+t.end || (+t.start || 0));
        }

        produced++;
        // Yield if we hit chunk size or frame budget
        if (produced >= CHUNK_SIZE) break;
        if ((performance.now() - startBudget) >= MAX_RAF_MS) break;
      }

      root.appendChild(frag);

      if (i < tokens.length) {
        // Continue next frame
        requestAnimationFrame(step);
      } else {
        // Initial paint touches
        this.#repaintProbabilities(state);
        this.#updateActiveWord(state);
      }
    };

    requestAnimationFrame(step);
  }

  #repaintProbabilities(state) {
    const enabled = !!state.settings?.probEnabled;
    for (let k = 0; k < this.wordEls.length; k++) {
      const el = this.wordEls[k];
      const prob = parseFloat(el.dataset.prob);
      paintProbability(el, prob, enabled, /*threshold*/ 0.95);
    }
  }

  #updateActiveWord(state) {
    const t = +state.playback.currentTime || 0;
    const i = findActiveIndex(t, this.starts, this.ends, this.lastActive);
    if (i === this.lastActive) return;

    // clear previous
    if (this.lastActive >= 0) setActive(this.wordEls[this.lastActive], false);
    // set new
    if (i >= 0) {
      const el = this.wordEls[i];
      setActive(el, true);
      // keep visible (cheap auto-scroll)
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    this.lastActive = i;
  }
}

/* =========================
   Public helper
   ========================= */

/**
 * Mounts the transcript view on a container.
 * @param {HTMLElement} root
 * @returns {{ destroy:()=>void }}
 */
export function setupTranscriptView(root) {
  const view = new TranscriptView(root);
  return { destroy: () => view.destroy() };
}

/* =========================
   Local helpers
   ========================= */

function findActiveIndex(t, starts, ends, lastIdx) {
  // Fast neighborhood probe first
  let i = lastIdx;
  if (i >= 0 && i < starts.length) {
    if (t >= starts[i] && t <= ends[i]) return i;
    const next = i + (t > ends[i] ? 1 : -1);
    if (next >= 0 && next < starts.length && t >= starts[next] && t <= ends[next]) return next;
  }
  // Fallback linear scan (you can replace with binary search later)
  for (let k = 0; k < starts.length; k++) {
    if (t >= starts[k] && t <= ends[k]) return k;
  }
  return -1;
}
