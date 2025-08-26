// confirm.js
// Confirmation marks feature:
// - Build anchor triples (prefix/exact/suffix) from current selection
// - Save / remove confirmations in Supabase via DataAPI
// - Reattach confirmations to the live text using diff-match-patch
// - Drive highlight overlays via TranscriptView.applyConfirmedRanges()
//
// No DOM buttons here; wire your own UI to call markReliable/markUnreliable.
// Works with the modules:
//   - data.js  -> createDataAPI() / DataAPI
//   - view.js  -> TranscriptView
//
// Usage (typical):
//   const confirm = new ConfirmFeature({ api, view });
//   confirm.setFilePath(filePath);
//   // when user presses "mark reliable":
//   await confirm.markReliable();
//   // when "mark unreliable":
//   await confirm.markUnreliable();
//   // automatically stays in sync when the user edits text (via view 'change' event).

import DiffMatchPatch from 'https://esm.sh/diff-match-patch@1.0.5?target=es2022';

/** @typedef {{ id:number, file_path:string, base_sha256:string, start_offset?:number, end_offset?:number, prefix?:string, exact?:string, suffix?:string }} ConfirmationRow */

const DMP = new DiffMatchPatch();

function buildAnchors(text, start, end, ctx = 32) {
  const s = Math.max(0, Math.min(text.length, start || 0));
  const e = Math.max(0, Math.min(text.length, end ?? s));
  return {
    start_offset: s,
    end_offset: e,
    prefix: text.slice(Math.max(0, s - ctx), s),
    exact: text.slice(s, e),
    suffix: text.slice(e, Math.min(text.length, e + ctx)),
  };
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reattach one saved mark to current text using diff-match-patch, with hints.
 * Returns [start, end] or null.
 */
function reattachMarkToText(mark, text) {
  if (!mark?.exact) return null;

  // be tolerant but deterministic
  DMP.Match_Threshold = 0.35;
  DMP.Match_Distance = 1000;

  const hint = Math.max(0, Math.min(text.length, mark.start_offset || 0));

  // 1) try direct exact near hint
  let loc = DMP.match_main(text, mark.exact, hint);
  if (loc >= 0) return [loc, loc + mark.exact.length];

  // 2) try prefix then exact near it
  if (mark.prefix) {
    const ph = DMP.match_main(text, mark.prefix, Math.max(0, hint - mark.prefix.length));
    if (ph >= 0) {
      loc = DMP.match_main(text, mark.exact, ph);
      if (loc >= 0) return [loc, loc + mark.exact.length];
    }
  }
  // 3) try suffix then exact just before it
  if (mark.suffix) {
    const sh = DMP.match_main(text, mark.suffix, hint);
    if (sh >= 0) {
      loc = DMP.match_main(text, mark.exact, Math.max(0, sh - mark.exact.length));
      if (loc >= 0) return [loc, loc + mark.exact.length];
    }
  }
  // 4) fallback linear (last resort)
  loc = text.indexOf(mark.exact);
  return (loc >= 0) ? [loc, loc + mark.exact.length] : null;
}

function reattachAll(marks, text) {
  const out = [];
  for (const m of marks) {
    const span = reattachMarkToText(m, text);
    if (span) out.push({ id: m.id, range: span });
  }
  return out;
}

function selectionCoverage(sel, ranges) {
  if (!sel) return 0;
  const [s, e] = sel;
  const L = Math.max(1, e - s);
  let covered = 0;
  for (const { range: [a, b] } of ranges || []) {
    const x = Math.max(s, a), y = Math.min(e, b);
    if (y > x) covered += (y - x);
  }
  return covered / L;
}

function subtractSpan([a, b], [s, e]) {
  // returns segments of [a,b] minus [s,e]
  if (e <= a || s >= b) return [[a, b]];
  if (s <= a && e >= b) return [];
  if (s <= a && e < b) return [[e, b]];
  if (s > a && e >= b) return [[a, s]];
  return [[a, s], [e, b]];
}

export class ConfirmFeature {
  /**
   * @param {{
   *   api: { // DataAPI
   *     fetchConfirmations(filePath:string):Promise<any[]>,
   *     ensureTranscriptRow(filePath:string, base_sha256:string, text?:string):Promise<void>,
   *     insertConfirmation(filePath:string, mark:any, opt?:{textIfMissing?:string}):Promise<void>,
   *     insertConfirmationsBatch(rows:any[], ctx:{filePath:string,base_sha256:string,textIfMissing?:string}):Promise<void>,
   *     deleteConfirmations(ids:number[]):Promise<void>,
   *   },
   *   view: {
   *     getPlainText():string,
   *     getSelectionOffsets():[number,number]|null,
   *     setSelectionByOffsets(start:number,end:number):void,
   *     applyConfirmedRanges(ranges:Array<{range:[number,number]}>):void,
   *     on(evt:'change'|'selection', fn:(payload:any)=>void):()=>void,
   *   },
   *   anchorContext?: number
   * }} opts
   */
  constructor({ api, view, anchorContext = 32 }) {
    this.api = api;
    this.view = view;
    this.anchorContext = anchorContext;

    /** @type {string|null} */
    this.filePath = null;

    /** @type {ConfirmationRow[]} */
    this.confirmedMarksRaw = [];
    /** @type {Array<{id:number, range:[number,number]}>} */
    this.confirmedRanges = [];

    // keep highlights in sync with edits
    this._unsubChange = this.view.on('change', () => {
      this._reattachAndPaint();
    });
  }

  destroy() {
    if (this._unsubChange) this._unsubChange();
  }

  setFilePath(filePath) {
    this.filePath = filePath || null;
    return this.refresh();
  }

  /** fetch from DB, reattach to current text, paint */
  async refresh() {
    if (!this.filePath) {
      this.confirmedMarksRaw = [];
      this.confirmedRanges = [];
      this.view.applyConfirmedRanges([]);
      return;
    }
    this.confirmedMarksRaw = await this.api.fetchConfirmations(this.filePath);
    this._reattachAndPaint();
  }

  /** fraction [0..1] of current selection already covered by confirmations */
  selectionCoverage() {
    const sel = this.view.getSelectionOffsets();
    return selectionCoverage(sel, this.confirmedRanges);
  }

  /** Add a new confirmation covering the current selection */
  async markReliable() {
    if (!this.filePath) throw new Error('No file selected');
    const sel = this.view.getSelectionOffsets();
    if (!sel) return;
    const [s, e] = sel;
    if (e <= s) return;

    const text = this.view.getPlainText();
    const base_sha256 = await sha256Hex(text);
    const mark = buildAnchors(text, s, e, this.anchorContext);

    // ensure parent row exists (handles FK)
    await this.api.ensureTranscriptRow(this.filePath, base_sha256, text);
    await this.api.insertConfirmation(this.filePath, { base_sha256, ...mark }, { textIfMissing: text });

    await this.refresh();
  }

  /** Remove confirmation(s) overlapping the current selection (split if partial) */
  async markUnreliable() {
    if (!this.filePath) throw new Error('No file selected');
    const sel = this.view.getSelectionOffsets();
    if (!sel) return;
    const [s, e] = sel;
    if (e <= s) return;

    const text = this.view.getPlainText();
    const base_sha256 = await sha256Hex(text);

    // reattach all to the live text and find overlaps
    const live = reattachAll(this.confirmedMarksRaw, text);
    const overlapping = live.filter(m => !(e <= m.range[0] || s >= m.range[1]));
    if (!overlapping.length) {
      // nothing to remove
      return;
    }

    // compute leftover slices for each overlapping mark
    const leftovers = [];
    for (const m of overlapping) {
      for (const [x, y] of subtractSpan(m.range, [s, e])) {
        if (y > x) {
          leftovers.push({
            file_path: this.filePath,
            base_sha256,
            ...buildAnchors(text, x, y, this.anchorContext),
          });
        }
      }
    }

    // ensure parent row exists
    await this.api.ensureTranscriptRow(this.filePath, base_sha256, text);

    // insert leftovers (if any), then delete originals
    if (leftovers.length) {
      await this.api.insertConfirmationsBatch(leftovers, {
        filePath: this.filePath,
        base_sha256,
        textIfMissing: text,
      });
    }
    await this.api.deleteConfirmations(overlapping.map(m => m.id));

    await this.refresh();
  }

  // ---------------------------- internals -----------------------------------

  _reattachAndPaint() {
    const text = this.view.getPlainText();
    this.confirmedRanges = reattachAll(this.confirmedMarksRaw, text);
    this.view.applyConfirmedRanges(this.confirmedRanges);
  }
}

export { buildAnchors, reattachMarkToText, reattachAll, subtractSpan, selectionCoverage };
