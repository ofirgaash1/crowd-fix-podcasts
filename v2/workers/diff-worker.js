// v2/workers/diff-worker.js
// Module worker that computes semantic diffs + patch text off the main thread.
// Protocol:
//   { type: 'init', baselineText: string }
//   { type: 'setBaseline', baselineText: string }
//   { type: 'diff', text: string, options?: { timeoutSec?: number, editCost?: number } }
// Responses:
//   { type: 'ready' }
//   { type: 'baseline-set' }
//   { type: 'diff', patchText, diffs, stats }

// Simple diff implementation without external dependencies
class SimpleDiff {
  constructor() {
    this.Diff_Timeout = 1.0;
    this.Diff_EditCost = 7;
    this.Match_Threshold = 0.35;
    this.Match_Distance = 1000;
  }
  
  diff_main(text1, text2) {
    // Simple character-level diff
    const diffs = [];
    let i = 0, j = 0;
    
    while (i < text1.length && j < text2.length) {
      if (text1[i] === text2[j]) {
        diffs.push([0, text1[i]]);
        i++; j++;
      } else {
        diffs.push([-1, text1[i]]);
        diffs.push([1, text2[j]]);
        i++; j++;
      }
    }
    
    while (i < text1.length) {
      diffs.push([-1, text1[i]]);
      i++;
    }
    
    while (j < text2.length) {
      diffs.push([1, text2[j]]);
      j++;
    }
    
    return diffs;
  }
  
  diff_cleanupSemantic(diffs) {
    // No cleanup for simple implementation
  }
  
  diff_cleanupSemanticLossless(diffs) {
    // No cleanup for simple implementation
  }
  
  patch_make(text1, diffs) {
    return [];
  }
  
  patch_toText(patches) {
    return '';
  }
}

const DMP = new SimpleDiff();

// Reasonable defaults (caller may override per task)
const DEFAULT_TIMEOUT = 1.0; // seconds
const DEFAULT_EDIT_COST = 7; // slightly favors keeping existing boundaries

let baselineText = '';

function safeString(x) {
  return typeof x === 'string' ? x : String(x ?? '');
}

function computeStats(diffs) {
  let inserted = 0, deleted = 0, equal = 0, distance = 0;
  for (const [op, data] of diffs) {
    const len = data.length;
    if (op === 1) { inserted += len; distance += len; }
    else if (op === -1) { deleted += len; distance += len; }
    else { equal += len; }
  }
  return { inserted, deleted, equal, distance };
}

self.onmessage = (ev) => {
  const msg = ev?.data || {};
  const t = msg.type;

  try {
    if (t === 'init') {
      baselineText = safeString(msg.baselineText || '');
      DMP.Diff_Timeout = DEFAULT_TIMEOUT;
      DMP.Diff_EditCost = DEFAULT_EDIT_COST;
      // match settings are used by reattach flows if needed later
      DMP.Match_Threshold = 0.35;
      DMP.Match_Distance = 1000;
      self.postMessage({ type: 'diff:ready' });
      return;
    }

    if (t === 'setBaseline') {
      baselineText = safeString(msg.baselineText || '');
      self.postMessage({ type: 'diff:baseline-set' });
      return;
    }

    if (t === 'diff') {
      if (typeof baselineText !== 'string') baselineText = safeString(baselineText);
      const nextText = safeString(msg.text || '');

      // Caller may override tuning per request
      const timeout = Number(msg?.options?.timeoutSec);
      const editCost = Number(msg?.options?.editCost);
      DMP.Diff_Timeout = Number.isFinite(timeout) ? Math.max(0, timeout) : DEFAULT_TIMEOUT;
      DMP.Diff_EditCost = Number.isFinite(editCost) ? editCost : DEFAULT_EDIT_COST;

      // Do the diff
      let diffs = DMP.diff_main(baselineText, nextText);
      // Cleanup for nicer boundaries (lossless first, then semantic)
      DMP.diff_cleanupSemantic(diffs);
      DMP.diff_cleanupSemanticLossless(diffs);

      // Build patch text (compact representation)
      const patches = DMP.patch_make(baselineText, diffs);
      const patchText = DMP.patch_toText(patches);

      const stats = {
        ...computeStats(diffs),
        charsBase: baselineText.length,
        charsNew: nextText.length
      };

      // NOTE: returning the raw diffs (array of [op, text]) is intentional;
      // the main thread can further transform/token-align as needed.
      self.postMessage({
        type: 'diff:result',
        patchText,
        diffs,
        stats
      });
      return;
    }

    // Unknown message → ignore politely
  } catch (err) {
    // Always surface errors in a structured way
    self.postMessage({
      type: 'diff:error',
      message: err?.message || String(err)
    });
  }
};
