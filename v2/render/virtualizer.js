// v2/render/virtualizer.js
// Thin adapter that delegates painting to OverlayRenderer.
// main.js (or your controller) calls these setters when state changes.

import { OverlayRenderer, computeAbsIndexMap } from './overlay.js';

export class ScrollVirtualizer {
  /**
   * @param {{ container: HTMLElement, scrollEl?: HTMLElement, renderer?: OverlayRenderer }} opts
   */
  constructor(opts = {}) {
    const { container, scrollEl, renderer } = opts;
    if (!container) throw new Error('ScrollVirtualizer: container is required');

    this.container = container;
    this.scrollEl = scrollEl || container;
    this.renderer = renderer || new OverlayRenderer({ container, windowSize: 800 });

    // cached inputs
    this.tokens = [];
    this.absIndex = [];

    // windowing helpers
    this.windowSize = 800;
    this._onScroll = this._onScroll?.bind ? this._onScroll.bind(this) : () => {};
    this.scrollEl.addEventListener('scroll', () => this._onScroll(), { passive: true });
  }

  /** Replace tokens and repaint everything */
  setTokens(tokens = []) {
    this.tokens = Array.isArray(tokens) ? tokens : [];
    this.absIndex = computeAbsIndexMap(this.tokens);
    this.renderer.setContainer(this.container);
    const t0 = performance.now();
    this.renderer.setTokens(this.tokens, this.absIndex);
    this._lastRenderMs = performance.now() - t0;
    this._updateWindowFromScroll();
  }

  /** Update confirmed ranges and repaint markings */
  setConfirmedRanges(ranges = []) {
    this.renderer.setConfirmedRanges(Array.isArray(ranges) ? ranges : []);
  }

  /** Toggle probability highlighting */
  setProbEnabled(on) {
    this.renderer.setProbEnabled(!!on);
  }

  /** Optional: adjust probability threshold (default 0.95) */
  setProbThreshold(v) {
    this.renderer.setProbThreshold(typeof v === 'number' ? v : 0.95);
  }

  /** Karaoke pointer */
  updateActiveIndex(i) {
    this.renderer.updateActiveIndex(i);
  }

  /** Stats for dev HUD */
  getStats() {
    return {
      tokens: (this.tokens || []).length,
      spans: typeof this.renderer.getRenderedCount === 'function' ? this.renderer.getRenderedCount() : (this.tokens || []).length,
      renderMs: this._lastRenderMs || 0
    };
  }

  _onScroll() {
    if (this._scrollThrottle) return;
    this._scrollThrottle = true;
    setTimeout(() => { this._scrollThrottle = false; this._updateWindowFromScroll(); }, 60);
  }

  _updateWindowFromScroll() {
    const totalTokens = (this.tokens || []).length;
    if (!totalTokens) return;
    const maxStart = Math.max(0, totalTokens - this.windowSize);
    const el = this.scrollEl || this.container;
    const sh = el.scrollHeight - el.clientHeight;
    const ratio = sh > 0 ? Math.max(0, Math.min(1, el.scrollTop / sh)) : 0;
    const start = Math.floor(ratio * maxStart);
    this.renderer.setWindowSize(this.windowSize);
    this.renderer.setWindowStart(start);
  }

  /** Cleanup hook (kept minimal; OverlayRenderer owns the DOM) */
  destroy() {
    this.container = null;
    this.scrollEl = null;
    this.tokens = [];
    this.absIndex = [];
  }
}
