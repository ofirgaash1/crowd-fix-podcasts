// v2/workers/align-worker.js
// Rebuild tokens for edited text off the main thread, preserving timings
// of unchanged words and interpolating new insertions.
//
// Protocol:
//  in:  { type:'align', seq, baselineTokens:[...], newText:string }
// out:  { type:'align-result', seq, tokens:[...] }
//
// NOTE: This currently aligns the WHOLE text (O(n*m) LCS). It’s in a worker,
// so the UI stays responsive. We’ll window this later using the "changed"
// region from the diff worker for big speed-ups.

const EPS = 1e-3;
const MIN_WORD_DUR = 0.02;

// ---------- tiny helpers ----------
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function isWS1ch(s) { return /^\s$/u.test(s); }     // exactly one WS char
function isWSrun(s) { return /^\s+$/u.test(s); }    // 1+ WS chars

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

// Split baseline tokens into ws/non-ws runs so LCS has finer granularity.
// Keep prob on non-WS runs only; make WS runs zero-duration anchors.
function normalizeBaselineForDiff(baselineTokens) {
  const out = [];
  for (const t of baselineTokens) {
    const txt = String(t.word || '');
    const prob = Number.isFinite(t.probability) ? t.probability : NaN;

    if (!txt) { out.push({ word: '', start: t.start, end: t.end, probability: NaN }); continue; }

    const parts = txt.match(/\s+|\S+/gu) || [txt];
    let pos = 0;
    for (const p of parts) {
      const from = pos; pos += p.length;
      if (isWSrun(p)) {
        const span = Math.max(0, (t.end || 0) - (t.start || 0));
        const L = Math.max(1, txt.length);
        const anchor = (t.start || 0) + span * (from / L);
        out.push({ word: p, start: anchor, end: anchor, probability: NaN });
      } else {
        out.push({ word: p, start: t.start, end: t.end, probability: prob });
      }
    }
  }
  return out;
}

// Assign times for inserted tokens by anchoring between neighbors.
// Preserves incoming start/end for non-insert (“keep”/“del”) tokens.
function assignTimesFromAnchors(arr) {
  const isWordKeep = w =>
    w.state === 'keep' && !isWS1ch(w.word) &&
    Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start;

  const isAnyKeep = w =>
    w.state === 'keep' &&
    Number.isFinite(w.start) && Number.isFinite(w.end);

  function leftAnchor(i) {
    for (let k = i - 1; k >= 0; k--) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isWordKeep(arr[k])) return arr[k];
    }
    for (let k = i - 1; k >= 0; k--) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isAnyKeep(arr[k])) return arr[k];
    }
    return null;
  }

  function rightAnchor(i) {
    for (let k = i + 1; k < arr.length; k++) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isWordKeep(arr[k])) return arr[k];
    }
    for (let k = i + 1; k < arr.length; k++) {
      if (arr[k].state === 'keep' && arr[k].word === '\n') return null;
      if (isAnyKeep(arr[k])) return arr[k];
    }
    return null;
  }

  let i = 0;
  while (i < arr.length) {
    if (arr[i].state !== 'ins') { i++; continue; }
    let j = i; while (j < arr.length && arr[j].state === 'ins') j++;

    const L = leftAnchor(i), R = rightAnchor(j - 1);
    const slice = arr.slice(i, j);
    const wordIdxs = slice.map((t, ix) => (isWS1ch(t.word) ? -1 : ix)).filter(ix => ix >= 0);
    const wordCount = wordIdxs.length;

    let winStart, winEnd;
    const winLenFor = n => Math.max(0.12 * Math.max(1, n), 0.12);

    if (L && R && R.start > L.end) { winStart = L.end; winEnd = R.start; }
    else if (L) { winStart = L.end; winEnd = L.end + winLenFor(wordCount); }
    else if (R) { winEnd = R.start; winStart = R.start - winLenFor(wordCount); }
    else { winStart = 0; winEnd = winLenFor(wordCount); }

    if (winEnd <= winStart) winEnd = winStart + winLenFor(wordCount);

    if (wordCount > 0) {
      const step = (winEnd - winStart) / (wordCount + 1);
      let nthWord = 0;
      let prevAssigned = Number.isFinite(L?.end) ? L.end : -Infinity;

      for (let k = 0; k < slice.length; k++) {
        const g = arr[i + k];

        if (isWS1ch(g.word)) {
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
      let a = winStart + (winEnd - winStart) / 2;
      if (L) a = Math.max(a, L.end + EPS);
      if (R) a = Math.min(a, R.start - EPS);
      for (let k = 0; k < slice.length; k++) {
        const g = arr[i + k];
        g.start = g.end = a;
      }
    }

    // Local monotonicity inside the slice
    (function monotonicize(leftBound) {
      let last = Number.isFinite(leftBound) ? leftBound : -Infinity;
      for (let k = i; k < j; k++) {
        const g = arr[k], ws = isWS1ch(g.word);
        if (!Number.isFinite(g.start)) g.start = last + EPS;
        if (g.start < last - EPS) g.start = last + EPS;
        if (!Number.isFinite(g.end)) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        if (g.end < g.start) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        last = g.start;
      }
    })(L?.end);

    i = j;
  }

  // Global sweep
  let prev = -Infinity;
  for (let k = 0; k < arr.length; k++) {
    const t = arr[k];
    if (t.state === 'del' || t.word === '\n') continue;
    const ws = isWS1ch(t.word);

    if (!Number.isFinite(t.start)) t.start = prev + EPS;
    if (!Number.isFinite(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);

    if (t.start < prev - EPS) {
      if (t.state === 'ins' || ws || t.end < prev) {
        t.start = prev + EPS;
        if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
      }
    }
    prev = Math.max(prev, t.start);
  }
}

// Core aligner (LCS over baseline-runs vs. new tokens)
function rebuildTokens(baselineTokens, newText) {
  const A = normalizeBaselineForDiff(baselineTokens);
  const B = tokenize(newText);
  const aWords = A.map(w => w.word);

  const m = aWords.length, n = B.length;
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
      const w = A[i++]; // deletion
      out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability });
    } else {
      out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN }); // inserted → prob NaN
    }
  }
  while (i < m) { const w = A[i++]; out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability }); }
  while (j < n) { out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN }); }

  assignTimesFromAnchors(out);
  return out;
}

// ---------- worker protocol ----------
self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'align') return;
  const { seq = 0, baselineTokens = [], newText = '' } = msg;
  const tokens = rebuildTokens(baselineTokens, newText);
  self.postMessage({ type: 'align-result', seq, tokens });
};
