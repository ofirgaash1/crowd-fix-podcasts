// v2/workers/align-worker.js
// Align edited plain-text back to timing-bearing tokens off the main thread.
// Protocol:
//   { type: 'init', baselineTokens: Token[] }                       -> { type: 'ready' }
//   { type: 'setBaseline', baselineTokens: Token[] }                -> { type: 'baseline-set' }
//   { type: 'align', text: string }                                 -> { type: 'aligned', tokens: Token[] }
// Types:
//   Token = { word:string, start:number, end:number, probability:number|null|undefined } | { word:'\n', start:number, end:number }

const EPS = 1e-3;
const MIN_WORD_DUR = 0.02;

let baselineTokens = []; // tokens with word/start/end/probability; includes '\n' tokens

/* =========================
   Utilities
   ========================= */

function toString(x) { return typeof x === 'string' ? x : String(x ?? ''); }
function isFiniteNum(x) { return Number.isFinite(x); }

/** Split text into tokens preserving whitespace as separate tokens */
function tokenize(text) {
  const out = [];
  let buf = '';
  for (const ch of Array.from(text)) {
    if (/\s/u.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Words→plain text (skipping deletions) */
function wordsToText(tokens) {
  return tokens.filter(t => t.state !== 'del').map(t => t.word).join('');
}

/** Normalize baseline so that whitespace runs become zero-length “anchors” */
function normalizeBaselineForDiff(base) {
  const out = [];
  const isWS = (s) => /^\s+$/u.test(s);

  for (const t of base) {
    const txt = toString(t.word || '');
    const prob = isFiniteNum(t.probability) ? t.probability : NaN;
    // Allow explicit newline tokens to pass-through as a single \n anchor
    if (txt === '\n') {
      out.push({ word: '\n', start: t.start ?? 0, end: t.end ?? (t.start ?? 0), probability: NaN });
      continue;
    }

    if (!txt) {
      out.push({ word: '', start: t.start ?? 0, end: t.end ?? (t.start ?? 0), probability: NaN });
      continue;
    }

    const parts = txt.match(/\s+|\S+/gu) || [txt];
    let pos = 0;
    for (const p of parts) {
      const from = pos;
      pos += p.length;

      if (isWS(p)) {
        const span = Math.max(0, (t.end || 0) - (t.start || 0));
        const L = Math.max(1, txt.length);
        const anchor = (t.start || 0) + span * (from / L);
        out.push({ word: p, start: anchor, end: anchor, probability: NaN });
      } else {
        out.push({ word: p, start: t.start ?? 0, end: t.end ?? (t.start ?? 0), probability: prob });
      }
    }
  }
  return out;
}

/** Assign times to inserted tokens using surrounding anchors (windowing) */
function assignTimesFromAnchors(arr) {
  const isWSChar = (s) => /^\s$/u.test(s);
  const isWordKeep = (w) => w.state === 'keep' && !isWSChar(w.word) && isFiniteNum(w.start) && isFiniteNum(w.end) && w.end > w.start;
  const isAnyKeep  = (w) => w.state === 'keep' && isFiniteNum(w.start) && isFiniteNum(w.end);

  const leftAnchor = (i) => {
    for (let k = i - 1; k >= 0; k--) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isWordKeep(arr[k])) return arr[k];
    }
    for (let k = i - 1; k >= 0; k--) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isAnyKeep(arr[k])) return arr[k];
    }
    return null;
  };

  const rightAnchor = (i) => {
    for (let k = i + 1; k < arr.length; k++) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isWordKeep(arr[k])) return arr[k];
    }
    for (let k = i + 1; k < arr.length; k++) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isAnyKeep(arr[k])) return arr[k];
    }
    return null;
  };

  let i = 0;
  while (i < arr.length) {
    if (arr[i].state !== 'ins') { i++; continue; }
    let j = i;
    while (j < arr.length && arr[j].state === 'ins') j++;

    const L = leftAnchor(i), R = rightAnchor(j - 1);
    const slice = arr.slice(i, j);
    const wordIdxs = slice.map((t, ix) => (isWSChar(t.word) ? -1 : ix)).filter(ix => ix >= 0);
    const wordCount = wordIdxs.length;

    let winStart, winEnd;
    const winLenFor = (n) => Math.max(0.12 * Math.max(1, n), 0.12);

    if (L && R && R.start > L.end) {
      winStart = L.end; winEnd = R.start;
    } else if (L) {
      winStart = L.end; winEnd = L.end + winLenFor(wordCount);
    } else if (R) {
      winEnd = R.start; winStart = R.start - winLenFor(wordCount);
    } else {
      winStart = 0; winEnd = winLenFor(wordCount);
    }
    if (winEnd <= winStart) winEnd = winStart + winLenFor(wordCount);

    if (wordCount > 0) {
      const step = (winEnd - winStart) / (wordCount + 1);
      let nthWord = 0;
      let prevAssigned = isFiniteNum(L?.end) ? L.end : -Infinity;

      for (let k = 0; k < slice.length; k++) {
        const g = arr[i + k];
        if (isWSChar(g.word)) {
          let anchor = winStart + (winEnd - winStart) * ((k + 1) / (slice.length + 1));
          anchor = Math.max(anchor, prevAssigned + EPS, winStart + EPS);
          if (R) anchor = Math.min(anchor, R.start - EPS);
          g.start = g.end = anchor;
          prevAssigned = g.start;
          continue;
        }
        nthWord++;
        const center = winStart + step * nthWord;
        let s = center - step * 0.45;
        s = Math.max(s, prevAssigned + EPS, winStart + EPS);
        if (R) s = Math.min(s, R.start - EPS);
        let e = s + Math.max(MIN_WORD_DUR, step * 0.9);
        if (R && e > R.start - EPS) e = Math.max(s + MIN_WORD_DUR, R.start - EPS);

        g.start = s;
        g.end = e;
        prevAssigned = g.start;
      }
    } else {
      // whitespace-only insertion cluster: put at mid
      let a = winStart + (winEnd - winStart) / 2;
      if (L) a = Math.max(a, L.end + EPS);
      if (R) a = Math.min(a, R.start - EPS);
      for (let k = 0; k < slice.length; k++) {
        const g = arr[i + k];
        g.start = g.end = a;
      }
    }

    // monotonicize within cluster
    (function monotonicize(leftBound) {
      let last = isFiniteNum(leftBound) ? leftBound : -Infinity;
      for (let k = i; k < j; k++) {
        const g = arr[k];
        const ws = isWSChar(g.word);
        if (!isFiniteNum(g.start)) g.start = last + EPS;
        if (g.start < last - EPS) g.start = last + EPS;
        if (!isFiniteNum(g.end)) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        if (g.end < g.start) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        last = g.start;
      }
    })(L?.end);

    i = j;
  }

  // global pass: enforce non-decreasing starts
  let prev = -Infinity;
  for (let k = 0; k < arr.length; k++) {
    const t = arr[k];
    if (t.state === 'del' || t.word === '\n') continue;
    const ws = isWSChar(t.word);
    if (!isFiniteNum(t.start)) t.start = prev + EPS;
    if (!isFiniteNum(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    if (t.start < prev - EPS) {
      t.start = prev + EPS;
      if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    }
    prev = Math.max(prev, t.start);
  }
}

/** Convert aligned tokens (keep/ins/del + '\n') → final token stream (no 'del') */
function finalizeTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.state === 'del') continue;
    out.push({
      word: t.word,
      start: t.start,
      end: t.end,
      probability: isFiniteNum(t.probability) ? t.probability : null
    });
  }
  return out;
}

/* =========================
   Core alignment
   ========================= */

/**
 * Build aligned token stream from baseline tokens and newText:
 *  1) normalize baseline for char-level diff, splitting whitespace to zero-length anchors
 *  2) run LCS (on words) to mark keep/del/ins
 *  3) time inserted tokens using anchor windows
 */
function alignFromBaseline(baseline, newText) {
  const A = normalizeBaselineForDiff(baseline); // tokens with word/start/end/prob
  const B = tokenize(toString(newText));
  const aWords = A.map(w => w.word);

  const m = aWords.length, n = B.length;
  // LCS DP
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = (aWords[i] === B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (aWords[i] === B[j]) {
      const w = A[i++]; j++;
      out.push({ word: w.word, start: w.start, end: w.end, state: 'keep', probability: w.probability });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      const w = A[i++];
      out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability });
    } else {
      out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN });
    }
  }
  while (i < m) {
    const w = A[i++];
    out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability });
  }
  while (j < n) {
    out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN });
  }

  assignTimesFromAnchors(out);
  return finalizeTokens(out);
}

/* =========================
   Worker protocol
   ========================= */

self.onmessage = (ev) => {
  const msg = ev?.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'init') {
      baselineTokens = Array.isArray(msg.baselineTokens) ? msg.baselineTokens : [];
      self.postMessage({ id, type: 'align:ready' });
      return;
    }
    if (msg.type === 'setBaseline') {
      baselineTokens = Array.isArray(msg.baselineTokens) ? msg.baselineTokens : [];
      self.postMessage({ id, type: 'align:baseline-set' });
      return;
    }
    if (msg.type === 'align') {
      const text = toString(msg.text || '');
      const result = alignFromBaseline(baselineTokens, text);
      self.postMessage({ id, type: 'align:result', tokens: result });
      return;
    }
  } catch (err) {
    self.postMessage({
      id,
      type: 'align:error',
      message: err?.message || String(err)
    });
  }
};
