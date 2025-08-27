// v2/render/virtualizer.js
// Thin adapter that delegates painting to OverlayRenderer.
// main.js (or your controller) calls these setters when state changes.

import { OverlayRenderer, computeAbsIndexMap } from './overlay.js';

export class ScrollVirtualizer {
  /**
   * @param {{ container: HTMLElement, renderer?: OverlayRenderer }} opts
   */
  constructor(opts = {}) {
    const { container, renderer } = opts;
    if (!container) throw new Error('ScrollVirtualizer: container is required');

    this.container = container;
    this.renderer = renderer || new OverlayRenderer({ container });

    // cached inputs
    this.tokens = [];
    this.absIndex = [];
  }

  /** Replace tokens and repaint everything */
  setTokens(tokens = []) {
    this.tokens = Array.isArray(tokens) ? tokens : [];
    this.absIndex = computeAbsIndexMap(this.tokens);
    this.renderer.setContainer(this.container);
    this.renderer.setTokens(this.tokens, this.absIndex);
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

  /** Cleanup hook (kept minimal; OverlayRenderer owns the DOM) */
  destroy() {
    this.container = null;
    this.tokens = [];
    this.absIndex = [];
  }
}
