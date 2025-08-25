// script.js  (ESM)

import DiffMatchPatch from 'https://esm.sh/diff-match-patch@1.0.5';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ungzip } from 'https://esm.sh/pako@2.1.0';

/* =========================
   Config / singletons
   ========================= */
const DMP = new DiffMatchPatch();

const SUPABASE_URL = 'https://xblbzxyyoptnfrlffigv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibGJ6eHl5b3B0bmZybGZmaWd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3ODI1MjgsImV4cCI6MjA3MTM1ODUyOH0.eIB279AoKwL5mrXuX1BQxa1mevVXMPrZK2VLaZ5kTNE'; // <-- put your anon key here
const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

/* =========================
   DOM helpers & refs
   ========================= */
const $ = (id) => document.getElementById(id);
const els = {
  // chrome
  panel: $('panel'),
  gutterL: $('gutterL'),
  gutterR: $('gutterR'),

  // player area
  player: $('player'),
  rate: $('rate'),
  rateVal: $('rateVal'),
  settingsBtn: $('settingsBtn'),
  modal: $('modal'),
  hfToken: $('hfToken'),
  mSave: $('mSave'),
  mClose: $('mClose'),
  mClear: $('mClear'),
  dlVtt: $('dlVtt'),

  // browser
  folders: $('folders'),
  files: $('files'),

  // transcript + diff
  transcript: $('transcript'),
  diffBody: $('diffBody'),

  // controls
  fontPlus: $('fontPlus'),
  fontMinus: $('fontMinus'),
  submitBtn: $('submitBtn'),
  probToggle: $('probToggle'),
};

const root = document.documentElement;

/* =========================
   State
   ========================= */
const TOKEN_KEY = 'hfToken';
const LS_W_NAV = 'w-nav';
const LS_W_DIFF = 'w-diff';
const LS_TEXTSZ = 'text-size-rem';

const EPS = 1e-3;
const MIN_WORD_DUR = 0.02;
const PROB_THRESH = 0.95; // paint only when p < 95%

const state = {
  data: { text: '', segments: [] },

  // token streams
  baselineTokens: [],      // immutable baseline (flattened)
  currentTokens: [],       // editable: {word, start, end, probability, state: 'keep'|'ins'|'del'}

  // render buffers
  wordEls: [],
  starts: [],
  ends: [],
  absStarts: [],   // NEW: absolute char start per rendered span
  absEnds: [],     // NEW: absolute char end per rendered span
  lastIdx: -1,


  // playback / edit
  editingFull: { active: false, resume: false, original: '', caret: 0 },
  editBox: null,

  // file browser
  currentFileNode: null,
  correctionsCache: new Set(),

  // loads
  lastLoad: { controller: null, token: 0 },
  objUrl: null,

  // diff baseline
  hfBaselineText: '',

  // undo/redo
  undoStack: [],
  redoStack: [],

  // prefs
  fontSizeRem: readInitialTextSizeRem(),

  /* ▼▼ confirmations ▼▼ */
  confirmedMarksRaw: [],   // raw rows from DB (with anchors)
  confirmedRanges: [],     // [{id, range:[start,end]}] mapped to current text

  // mode-less editing flags
  modelessPending: false,
  modelessComposing: false,

  // probability highlight toggle (persisted)
  probEnabled: (localStorage.getItem('probHL') ?? 'on') !== 'off',

  // modeless editing helpers
  _undoGuard: false,        // throttles undo snapshots during typing
  _pendingCaret: null,      // absolute caret offset to restore after re-render

  undoStack: [], redoStack: [],
  // === add these two ===
  composing: false,
  retokenizeTimer: 0,
};

/* =========================
   Utils
   ========================= */
const utils = {
  // --- caret/selection helpers for a contentEditable container ---
  plainText(node) {
    // innerText preserves \n on line breaks, closer to user-visible text
    return (node?.innerText || '').replace(/\r/g, '');
  },
  getSelectionOffsets(container) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    const inC = n => n && (n === container || container.contains(n));
    if (!(inC(r.startContainer) && inC(r.endContainer))) return null;

    const measure = (node, off) => {
      const rng = document.createRange();
      rng.selectNodeContents(container);
      try { rng.setEnd(node, off); } catch { return 0; }
      return rng.toString().length;
    };
    const s = measure(r.startContainer, r.startOffset);
    const e = measure(r.endContainer, r.endOffset);
    return [Math.min(s, e), Math.max(s, e)];
  },
  setSelectionByOffsets(container, start, end) {
    const text = utils.plainText(container);
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
    container.focus();
  },

  getTok: () => localStorage.getItem(TOKEN_KEY) || '',
  setTok: (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY),

  isHf(u) {
    try {
      const h = new URL(u).host;
      return h.endsWith('huggingface.co') || h.endsWith('hf.co');
    } catch { return false; }
  },

  getCssVar(name, fallback = '') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  },

  paintWordProb(el) {
    const color = utils.getCssVar('--prob-color', '255,235,59');       // RGB only, no 'rgb()'
    const baseAlpha = parseFloat(utils.getCssVar('--prob-alpha', '0.6')) || 0.6;
    const p = parseFloat(el.dataset.prob);

    if (!state.probEnabled || !Number.isFinite(p)) {
      el.style.backgroundColor = '';
      return;
    }
    const alpha = utils.clamp01((1 - utils.clamp01(p)) * baseAlpha);   // lower prob → stronger
    el.style.backgroundColor = `rgba(${color}, ${alpha})`;
  },

  encPath: (p) => p.split('/').map(encodeURIComponent).join('/'),
  hfRes: (path, ds) => `https://huggingface.co/datasets/ivrit-ai/${ds}/resolve/main/${utils.encPath(path)}`,
  opusUrl: (p) => utils.hfRes(p, 'audio-v2-opus'),
  transUrl: (p) => utils.hfRes(p, 'audio-v2-transcripts'),

  normPaths(folder, file) {
    return {
      audioPath: `${folder}/${file}`,
      trPath: `${folder}/${file.replace(/\.opus$/i, '')}/full_transcript.json.gz`
    };
  },

  fetchAuth(u, o = {}) {
    const h = new Headers(o.headers || {});
    if (!h.has('Accept')) h.set('Accept', 'application/json');
    if (utils.getTok() && utils.isHf(u)) h.set('Authorization', 'Bearer ' + utils.getTok());
    return fetch(u, { ...o, headers: h, mode: 'cors', redirect: 'follow' });
  },

  t2(t) {
    if (!Number.isFinite(t)) return '00:00:00.000';
    const h = ('0' + Math.floor(t / 3600)).slice(-2);
    const m = ('0' + Math.floor(t % 3600 / 60)).slice(-2);
    const s = ('0' + Math.floor(t % 60)).slice(-2);
    const ms = ('00' + Math.floor((t % 1) * 1000)).slice(-3);
    return `${h}:${m}:${s}.${ms}`;
  },

  clearTranscript() {
    els.transcript.textContent = '';
    state.wordEls = [];
    state.starts = [];
    state.ends = [];
    state.absStarts = [];           // NEW
    state.absEnds = [];             // NEW
    state.lastIdx = -1;
  },

  clamp01: (v) => Math.max(0, Math.min(1, v)),

  escapeHtml: (text) =>
    String(text).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    )),

  clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),

  /* --- added for confirmations / selection / hashing --- */
  sha256: async (text) => {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  getCurrentPlainText: () => {
    if (state.editBox && state.editingFull.active) return (state.editBox.innerText || '').replace(/\r/g, '');
    return state.data?.text || '';
  },

  getSelectionOffsetsIn(container) {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const inC = (n) => n && (n === container || container.contains(n));
    if (!(inC(r.startContainer) || inC(r.endContainer))) return null;

    const probe = document.createRange();
    probe.selectNodeContents(container);

    let s = 0, e = 0;
    try { probe.setEnd(r.startContainer, r.startOffset); s = probe.toString().length; } catch { }
    try { probe.setEnd(r.endContainer, r.endOffset); e = probe.toString().length; } catch { }
    if (s === e) return null;
    return [Math.min(s, e), Math.max(s, e)];
  },

  getCurrentSelectionOffsets() {
    return (state.editingFull.active && state.editBox)
      ? utils.getSelectionOffsetsIn(state.editBox)
      : utils.getSelectionOffsetsIn(els.transcript);
  },

  buildAnchors(text, start, end, ctx = 32) {
    return {
      start_offset: start,
      end_offset: end,
      prefix: text.slice(Math.max(0, start - ctx), start),
      exact: text.slice(start, end),
      suffix: text.slice(end, Math.min(text.length, end + ctx))
    };
  },
};

/* =========================
   Confirmations (green text)
   ========================= */
const confirm = {
  /* ---- DB helpers ---- */
  async ensureTranscriptRow(filePath) {
    const { error } = await supa.from('transcripts').upsert({ file_path: filePath }, { onConflict: 'file_path' });
    if (error) throw error;
  },
  async fetch(filePath) {
    const { data, error } = await supa
      .from('transcript_confirmations')
      .select('*')
      .eq('file_path', filePath)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async save(filePath, mark) {
    await confirm.ensureTranscriptRow(filePath);
    const base_sha256 = await utils.sha256(utils.getCurrentPlainText());
    const row = { file_path: filePath, base_sha256, ...mark };
    const { error } = await supa.from('transcript_confirmations').insert(row);
    if (error) throw error;
  },
  async del(ids) {
    if (!ids?.length) return;
    const { error } = await supa.from('transcript_confirmations').delete().in('id', ids);
    if (error) throw error;
  },

  /* ---- reattach ---- */
  reattachMarkToText(mark, text) {
    if (!mark?.exact) return null;
    const hint = Math.max(0, Math.min(text.length, mark.start_offset || 0));
    DMP.Match_Threshold = 0.35;
    DMP.Match_Distance = 1000;
    let loc = DMP.match_main(text, mark.exact, hint);
    if (loc >= 0) return [loc, loc + mark.exact.length];

    if (mark.prefix) {
      const ph = DMP.match_main(text, mark.prefix, Math.max(0, hint - mark.prefix.length));
      if (ph >= 0) {
        loc = DMP.match_main(text, mark.exact, ph);
        if (loc >= 0) return [loc, loc + mark.exact.length];
      }
    }
    if (mark.suffix) {
      const sh = DMP.match_main(text, mark.suffix, hint);
      if (sh >= 0) {
        loc = DMP.match_main(text, mark.exact, Math.max(0, sh - mark.exact.length));
        if (loc >= 0) return [loc, loc + mark.exact.length];
      }
    }
    loc = text.indexOf(mark.exact);
    return (loc >= 0) ? [loc, loc + mark.exact.length] : null;
  },
  reattachAll(marks, text) {
    const out = [];
    for (const m of marks) {
      const span = confirm.reattachMarkToText(m, text);
      if (span) out.push({ id: m.id, range: span });
    }
    return out;
  },

  /* ---- painting ---- */
  applyHighlights() {
    if (!state.wordEls?.length) return;
    const ranges = state.confirmedRanges || [];

    // precompute absolute char index per token
    const abs = [];
    let acc = 0;
    for (let i = 0; i < state.currentTokens.length; i++) {
      const t = state.currentTokens[i];
      abs[i] = acc;
      if (t.state !== 'del') acc += (t.word || '').length;
    }

    for (const el of state.wordEls) {
      el.classList.remove('confirmed');
      const ti = +el.dataset.ti;
      const t = state.currentTokens[ti];
      if (!t || t.state === 'del' || t.word === '\n') continue;
      const s = abs[ti];
      const e = s + (t.word || '').length;
      const hit = ranges.some(({ range: [a, b] }) => !(e <= a || s >= b));
      if (hit) el.classList.add('confirmed');
    }
  },

  applyEditPreview() {
    if (!(state.editBox && state.editingFull.active)) return;

    // unwrap old
    state.editBox.querySelectorAll('span.confirmed').forEach(el => {
      const p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    });

    const text = (state.editBox.innerText || '').replace(/\r/g, '');
    const ranges = (state.confirmedRanges || []).slice().sort((a, b) => a.range[0] - b.range[0]);

    const tw = document.createTreeWalker(state.editBox, NodeFilter.SHOW_TEXT, null);
    let node, offset = 0, i = 0;
    while ((node = tw.nextNode())) {
      const len = node.nodeValue.length;
      const start = offset, end = offset + len;
      while (i < ranges.length && ranges[i].range[1] <= start) i++;
      let k = i;
      while (k < ranges.length && ranges[k].range[0] < end) {
        const a = Math.max(start, ranges[k].range[0]) - start;
        const b = Math.min(end, ranges[k].range[1]) - start;
        if (b > a) {
          const r = document.createRange();
          r.setStart(node, a);
          r.setEnd(node, b);
          const span = document.createElement('span');
          span.className = 'confirmed';
          try { r.surroundContents(span); }
          catch {
            const frag = r.cloneContents();
            span.appendChild(frag);
            r.deleteContents();
            r.insertNode(span);
          }
        }
        k++;
      }
      offset += len;
    }
  },

  /* ---- selection coverage & splitting ---- */
  selectionCoverage(sel) {
    if (!sel) return 0;
    const [s, e] = sel, L = Math.max(1, e - s);
    let covered = 0;
    for (const { range: [a, b] } of (state.confirmedRanges || [])) {
      const x = Math.max(s, a), y = Math.min(e, b);
      if (y > x) covered += (y - x);
    }
    return covered / L;
  },
  subtractSpan([a, b], [s, e]) {
    if (e <= a || s >= b) return [[a, b]];
    if (s <= a && e >= b) return [];
    if (s <= a && e < b) return [[e, b]];
    if (s > a && e >= b) return [[a, s]];
    return [[a, s], [e, b]];
  },

  /* ---- buttons ---- */
  updateButtons() {
    const yes = document.getElementById('markReliable');
    const no = document.getElementById('markUnreliable');
    if (!yes || !no) return;
    const sel = utils.getCurrentSelectionOffsets();
    if (!sel) { yes.style.display = ''; no.style.display = 'none'; return; }

    const frac = confirm.selectionCoverage(sel);

    if (frac <= 0) {          // 0% confirmed
      yes.style.display = '';
      no.style.display = 'none';
    } else if (frac >= 1) {   // 100% confirmed
      yes.style.display = 'none';
      no.style.display = '';
    } else {                 // mixed
      yes.style.display = '';
      no.style.display = '';
    }
  },

  setupButtons() {
    const yes = document.getElementById('markReliable');
    const no = document.getElementById('markUnreliable');
    if (!yes || !no) return;

    [yes, no].forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));

    yes.addEventListener('click', async () => {
      const sel = utils.getCurrentSelectionOffsets(); if (!sel) return;
      const [s, e] = sel;
      const text = utils.getCurrentPlainText();
      const mark = utils.buildAnchors(text, s, e, 32);
      const filePath = state.currentFileNode
        ? state.currentFileNode.dataset.folder + '/' + state.currentFileNode.dataset.file
        : null;
      if (!filePath) { alert('אין קובץ נבחר'); return; }

      try {
        await confirm.save(filePath, mark);
        await confirm.refreshForCurrentFile();
      } catch (err) {
        console.error(err); alert('שגיאה בסימון אמין');
      }
    });

    no.addEventListener('click', async () => {
      const sel = utils.getCurrentSelectionOffsets(); if (!sel) return;
      const [s, e] = sel;
      const filePath = state.currentFileNode
        ? state.currentFileNode.dataset.folder + '/' + state.currentFileNode.dataset.file
        : null;
      if (!filePath) { alert('אין קובץ נבחר'); return; }

      try {
        const text = utils.getCurrentPlainText();
        const live = confirm.reattachAll(state.confirmedMarksRaw, text);
        const overlapping = live.filter(m => !(e <= m.range[0] || s >= m.range[1]));
        if (!overlapping.length) { confirm.updateButtons(); return; }

        const leftovers = [];
        const base_sha256 = await utils.sha256(text);
        for (const m of overlapping) {
          for (const [x, y] of confirm.subtractSpan(m.range, [s, e])) {
            if (y > x) leftovers.push({
              file_path: filePath,
              base_sha256,
              ...utils.buildAnchors(text, x, y, 32)
            });
          }
        }
        if (leftovers.length) {
          await confirm.ensureTranscriptRow(filePath);
          const { error } = await supa.from('transcript_confirmations').insert(leftovers);
          if (error) throw error;
        }
        await confirm.del(overlapping.map(m => m.id));
        await confirm.refreshForCurrentFile();
      } catch (err) {
        console.error(err); alert('שגיאה בסימון כלא אמין');
      }
    });

    document.addEventListener('selectionchange', confirm.updateButtons);
    els.transcript.addEventListener('mouseup', confirm.updateButtons);
  },

  /* ---- refresh (call after load or text changes) ---- */
  async refreshForCurrentFile() {
    const filePath = state.currentFileNode
      ? state.currentFileNode.dataset.folder + '/' + state.currentFileNode.dataset.file
      : null;
    if (!filePath) return;

    state.confirmedMarksRaw = await confirm.fetch(filePath);
    state.confirmedRanges = confirm.reattachAll(state.confirmedMarksRaw, utils.getCurrentPlainText());

    confirm.applyHighlights();
    confirm.applyEditPreview();
    confirm.updateButtons();
  },
};

/* =========================
   Text/Token processing
   ========================= */
function tokenize(text) {
  const out = [];
  let buf = '';
  for (const ch of Array.from(text)) {
    if (/\s/u.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch); // each whitespace char is a token
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function wordsToText(words) {
  return words.filter(w => w.state !== 'del').map(w => w.word).join('');
}

function flattenToTokens(d) {
  const toks = [];
  let lastEnd = 0;
  (d.segments || []).forEach((s, si) => {
    (s.words || []).forEach(w => {
      toks.push({
        word: String(w.word || ''),
        start: +w.start || 0,
        end: +w.end || ((+w.start || 0) + 0.25),
        state: 'keep',
        probability: Number.isFinite(+w.probability) ? +w.probability : NaN
      });
      lastEnd = toks[toks.length - 1].end;
    });
    if (si < d.segments.length - 1) {
      toks.push({ word: '\n', start: lastEnd, end: lastEnd, state: 'keep', probability: NaN });
    }
  });
  return toks;
}

function normData(raw) {
  const d = JSON.parse(JSON.stringify(raw || {}));
  d.text = d.text || '';
  d.segments = Array.isArray(d.segments) ? d.segments : [];
  d.segments.forEach(s => {
    if (!Array.isArray(s.words) || !s.words.length) {
      s.words = [{ word: s.text || ' ', start: +s.start || 0, end: +s.end || (+s.start || 0) + .5 }];
    } else {
      s.words.forEach(w => {
        w.start = +w.start || 0;
        w.end = +w.end || w.start + .25;
        w.word = String(w.word || '');
      });
    }
  });
  return d;
}

/* Diff-aware reflow that keeps unchanged timings and interpolates inserts */
function buildFromBaseline(baselineTokens, newText) {
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
      const w = A[i++];
      out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability });
    } else {
      out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN });
    }
  }
  while (i < m) { const w = A[i++]; out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability }); }
  while (j < n) { out.push({ word: B[j++], start: NaN, end: NaN, state: 'ins', probability: NaN }); }

  assignTimesFromAnchors(out);
  return out;
}

function normalizeBaselineForDiff(baselineTokens) {
  const out = [], isWS = s => /^\s+$/u.test(s);
  for (const t of baselineTokens) {
    const txt = String(t.word || '');
    const prob = Number.isFinite(t.probability) ? t.probability : NaN;
    if (!txt) { out.push({ word: '', start: t.start, end: t.end, probability: NaN }); continue; }
    const parts = txt.match(/\s+|\S+/gu) || [txt];
    let pos = 0;
    for (const p of parts) {
      const from = pos; pos += p.length;
      if (isWS(p)) {
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

function assignTimesFromAnchors(arr) {
  const isWS = s => /^\s$/u.test(s);

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
    let j = i; while (j < arr.length && arr[j].state === 'ins') j++;

    const L = leftAnchor(i), R = rightAnchor(j - 1);
    const slice = arr.slice(i, j);
    const wordIdxs = slice.map((t, ix) => (/^\s$/u.test(t.word) ? -1 : ix)).filter(ix => ix >= 0);
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

        if (isWS(g.word)) {
          let anchor = winStart + (winEnd - winStart) * ((k + 1) / (slice.length + 1));
          anchor = Math.max(anchor, prevAssigned + EPS, winStart + EPS);
          if (R) anchor = Math.min(anchor, R.start - EPS);
          g.start = g.end = anchor;
          prevAssigned = g.start;
          continue;
        }

        nthWord++;
        const center = winStart + step * nthWord;
        let s = Math.max(center - step * 0.45, prevAssigned + EPS, winStart + EPS);
        if (R) s = Math.min(s, R.start - EPS);
        let e = s + Math.max(MIN_WORD_DUR, step * 0.9);
        if (R && e > R.start - EPS) e = Math.max(s + MIN_WORD_DUR, R.start - EPS);

        g.start = s; g.end = e;
        prevAssigned = g.start;
      }
    } else {
      // only whitespace
      let a = winStart + (winEnd - winStart) / 2;
      if (L) a = Math.max(a, L.end + EPS);
      if (R) a = Math.min(a, R.start - EPS);
      for (let k = 0; k < slice.length; k++) {
        const g = arr[i + k];
        g.start = g.end = a;
      }
    }

    // local monotonicity
    (function monotonicize(leftBound) {
      let last = Number.isFinite(leftBound) ? leftBound : -Infinity;
      for (let k = i; k < j; k++) {
        const g = arr[k], ws = isWS(g.word);
        if (!Number.isFinite(g.start)) g.start = last + EPS;
        if (g.start < last - EPS) g.start = last + EPS;
        if (!Number.isFinite(g.end)) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        if (g.end < g.start) g.end = g.start + (ws ? 0 : MIN_WORD_DUR);
        last = g.start;
      }
    })(L?.end);

    i = j;
  }

  // global sweep
  let prev = -Infinity;
  for (let k = 0; k < arr.length; k++) {
    const t = arr[k];
    if (t.state === 'del' || t.word === '\n') continue;
    const ws = /^\s$/u.test(t.word);

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

function repairChronology(tokens) {
  let prev = -Infinity;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.state === 'del' || t.word === '\n') continue;
    const ws = /^\s$/u.test(t.word);
    if (!Number.isFinite(t.start)) t.start = prev + EPS;
    if (!Number.isFinite(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    if (t.start < prev - EPS) {
      t.start = prev + EPS;
      if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    }
    prev = Math.max(prev, t.start);
  }
}

function tokensToData(tokens) {
  const segs = [];
  let words = [];
  let pendingWS = '';
  let pendingS = Infinity;

  for (const t of tokens) {
    if (t.state === 'del') continue;
    if (t.word === '\n') {
      segs.push(words);
      words = [];
      pendingWS = '';
      pendingS = Infinity;
      continue;
    }
    const is_ws = /^\s$/u.test(t.word);
    if (is_ws) {
      pendingWS += t.word;
      if (Number.isFinite(t.start)) pendingS = Math.min(pendingS, t.start);
    } else {
      const start = Number.isFinite(pendingS) ? Math.min(pendingS, t.start) : t.start;
      // preserve probability on the word!
      words.push({ word: pendingWS + t.word, start, end: t.end, probability: t.probability });
      pendingWS = '';
      pendingS = Infinity;
    }
  }
  if (words.length) segs.push(words);

  const text = segs.map(ws => ws.map(w => w.word).join('')).join('\n');

  return {
    text,
    segments: segs.map(ws => {
      const startsArr = ws.filter(w => Number.isFinite(w.start)).map(w => w.start);
      const endsArr = ws.filter(w => Number.isFinite(w.end)).map(w => w.end);
      const t0 = startsArr.length ? Math.min(...startsArr) : 0;
      const t1 = endsArr.length ? Math.max(...endsArr) : 0.25;
      return { start: t0, end: t1, text: ws.map(w => w.word).join(''), words: ws };
    })
  };
}

/* =========================
   Mode-less editing rebuild
   ========================= */
function requestRebuildFromTranscript() {
  if (state.modelessComposing) return;      // wait for IME to finish
  if (state.modelessPending) return;
  state.modelessPending = true;
  requestAnimationFrame(() => {
    state.modelessPending = false;
    rebuildFromTranscriptNow();
  });
}

function rebuildFromTranscriptNow() {
  const el = els.transcript;
  if (!el) return;

  // 1) capture selection + new plain text
  const sel = utils.getSelectionOffsets(el);
  const newText = utils.plainText(el);

  // 2) rebuild tokens & data from baseline
  try {
    state.undoStack.push(JSON.parse(JSON.stringify(state.currentTokens)));
    state.redoStack.length = 0;
    state.currentTokens = buildFromBaseline(state.baselineTokens, newText);
    state.data = tokensToData(state.currentTokens);
  } catch (err) {
    console.error('rebuildFromTranscript failed:', err);
    return;
  }

  // 3) re-render & re-apply visuals
  render();
  renderDiff?.();
  applyProbHighlights?.();
  confirm.applyHighlights?.();
  confirm.updateButtons?.();

  // 4) restore selection
  if (sel) utils.setSelectionByOffsets(el, sel[0], sel[1]);
}

/* =========================
   Modeless editing helpers
   ========================= */

// Extract plain text from #transcript (preserves \n you insert between segments)
function transcriptPlainText() {
  const tw = document.createTreeWalker(els.transcript, NodeFilter.SHOW_TEXT, null);
  let s = '', n;
  while ((n = tw.nextNode())) s += n.nodeValue;
  return s.replace(/\r/g, '');
}

// Absolute offsets of current selection inside #transcript.
// Returns [start, end] or null if selection is outside the transcript.
function getSelectionOffsetsInTranscript() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const inC = (node) => node && (node === els.transcript || els.transcript.contains(node));
  if (!(inC(r.startContainer) || inC(r.endContainer))) return null;

  const probe = document.createRange();
  probe.selectNodeContents(els.transcript);

  const toAbs = (node, off) => {
    try { probe.setEnd(node, off); } catch { return 0; }
    return probe.toString().length;
  };

  const s = toAbs(r.startContainer, r.startOffset);
  const e = toAbs(r.endContainer, r.endOffset);
  return s === e ? [s, s] : [Math.min(s, e), Math.max(s, e)];
}

// Map absolute offset -> DOM position after we re-render.
function domPosAtOffset(container, absOffset) {
  const text = (() => {
    const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let s = '', n;
    while ((n = tw.nextNode())) s += n.nodeValue;
    return s;
  })();
  const target = Math.max(0, Math.min(absOffset, text.length));
  const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node, count = 0;
  while ((node = tw.nextNode())) {
    const len = node.nodeValue.length;
    if (count + len >= target) return [node, target - count];
    count += len;
  }
  const last = container.lastChild;
  return (last && last.nodeType === Node.TEXT_NODE)
    ? [last, last.nodeValue.length]
    : [container, (container.textContent || '').length];
}

function placeCaretInTranscript(absOffset) {
  const [node, off] = domPosAtOffset(els.transcript, absOffset);
  const sel = window.getSelection();
  const range = document.createRange();
  try {
    range.setStart(node, off);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* ignore */ }
  els.transcript.focus();
}

// Apply user edits live: read text from DOM, diff vs baseline, rebuild tokens, render, restore caret, update diff
function handleLiveEdit() {
  const newText = transcriptPlainText();
  const curText = wordsToText(state.currentTokens.filter(t => t.state !== 'del'));
  if (newText === curText) return;

  // coalesce undo snapshots while typing
  if (!state._undoGuard) {
    state.undoStack.push(snapshot());
    state.redoStack = [];
    state._undoGuard = true;
    setTimeout(() => { state._undoGuard = false; }, 400);
  }

  // rebuild from baseline and re-render
  state.currentTokens = buildFromBaseline(state.baselineTokens, newText);
  state.data = tokensToData(state.currentTokens);

  // we captured desired caret position earlier into state._pendingCaret
  const restoreTo = state._pendingCaret;

  render();
  renderDiff();
  confirm?.applyHighlights?.();
  confirm?.updateButtons?.();

  if (Number.isFinite(restoreTo)) {
    // restore after the new DOM is in place
    requestAnimationFrame(() => placeCaretInTranscript(restoreTo));
  }
}

/* =========================
   Rendering & Diff
   ========================= */
function render() {
  if (state.editingFull.active) return;
  utils.clearTranscript();
  const f = document.createDocumentFragment();

  state.absStarts = [];           // NEW
  state.absEnds = [];             // NEW
  let absCursor = 0;              // NEW: running absolute char offset

  state.currentTokens.forEach((w, ti) => {
    if (w.state === 'del') return;

    if (w.word === '\n') {
      // count newline in absolute text so confirmations line up
      f.appendChild(document.createTextNode('\n'));
      absCursor += 1;            // NEW: advance absolute text by newline
      return;
    }


    const sp = document.createElement('span');
    sp.className = 'word';
    sp.textContent = w.word;
    sp.dataset.start = w.start;
    sp.dataset.end = w.end;
    sp.dataset.ti = ti;

    // keep the DOM light: round to 2 decimals
    if (Number.isFinite(w.probability)) {
      sp.dataset.prob = (Math.round(w.probability * 100) / 100).toFixed(2);
    }

    f.appendChild(sp);
    state.wordEls.push(sp);
    state.starts.push(w.start);
    state.ends.push(w.end);


    // NEW: absolute offsets for this rendered span
    const len = (w.word || '').length;
    state.absStarts.push(absCursor);
    absCursor += len;
    state.absEnds.push(absCursor);
  });

  els.transcript.appendChild(f);
  applyProbHighlights(); // paint (or clear) based on toggle
  confirm.applyHighlights?.();
  confirm.updateButtons?.();
}

function getCurrentPlainText() {
  // If we’re editing, read exactly what’s in the edit box (including newlines).
  if (state.editBox && state.editingFull.active) {
    // Walk text nodes to avoid accidental HTML side-effects
    const tw = document.createTreeWalker(state.editBox, NodeFilter.SHOW_TEXT, null);
    let s = '', n;
    while ((n = tw.nextNode())) s += n.nodeValue;
    return s.replace(/\r/g, '');
  }
  // Otherwise, rebuild from tokens (ignoring deleted tokens)
  return wordsToText(state.currentTokens.filter(t => t.state !== 'del'));
}

function renderDiff(curText /* optional */) {
  if (!els.diffBody) return;

  const base = state.hfBaselineText || '';
  // when editing modelessly, prefer the live DOM text
  const cur = (typeof curText === 'string')
    ? curText
    : utils.plainText(els.transcript);

  if (!base) {
    els.diffBody.textContent = cur;
    return;
  }

  DMP.Diff_Timeout = 2;
  DMP.Diff_EditCost = 8;

  const diffs = DMP.diff_main(base, cur);
  DMP.diff_cleanupSemantic(diffs);
  DMP.diff_cleanupSemanticLossless(diffs);

  els.diffBody.innerHTML = diffs.map(([op, data]) => {
    if (op === 1) return `<span class="diff-insert">${utils.escapeHtml(data)}</span>`;
    if (op === -1) return `<span class="diff-delete">${utils.escapeHtml(data)}</span>`;
    return `<span class="diff-equal">${utils.escapeHtml(data)}</span>`;
  }).join('');
}


/* =========================
   Probability highlighting
   ========================= */

function applyProbHighlights() {
  const root = els.transcript;
  if (!root) return;

  // one class on the container controls whether CSS paints anything
  root.classList.toggle('prob-on', !!state.probEnabled);

  const baseAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prob-alpha')) || 0.6;

  for (const el of state.wordEls) {
    const p = parseFloat(el.dataset.prob);
    let a = 0;
    if (state.probEnabled && Number.isFinite(p) && p < PROB_THRESH) {
      a = utils.clamp01((1 - p) * baseAlpha);
    }
    // if active, suppress so active bg is visible
    if (el.classList.contains('active')) a = 0;

    // set just the alpha var; no inline rgba string
    el.style.setProperty('--prob-a', String(a));
    // nuke any legacy inline background from older code
    el.style.backgroundColor = '';
  }
}



// Legacy hook: if anything calls window.paintWordEl(el), route to the utils painter
window.paintWordEl = utils.paintWordProb;



/* =========================
   Edit mode
   ========================= */

function getFullText() { return wordsToText(state.currentTokens); }

function snapshot() { return JSON.parse(JSON.stringify(state.currentTokens)); }



/* =========================
   Browser (HF) + Supabase
   ========================= */
function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.tree)) return json.tree;
  if (json && Array.isArray(json.siblings)) return json.siblings;
  return [];
}
function filterImmediate(items, base) {
  const depth = base ? base.split('/').filter(Boolean).length : 0;
  return items.filter(x => {
    const p = x.path || x.rpath || '';
    if (base && !p.startsWith(base + '/')) return false;
    const d = p.split('/').filter(Boolean).length;
    return d === depth + 1;
  });
}
async function listTree(path = '') {
  const base = 'https://huggingface.co/api/datasets/ivrit-ai/audio-v2-opus/tree/main';
  const urls = path ? [
    `${base}/${utils.encPath(path)}`,
    `${base}?path=${encodeURIComponent(path)}`
  ] : [base, `${base}?recursive=false`];
  let lastErr = null;

  for (const url of urls) {
    try {
      const r = await utils.fetchAuth(url, { headers: { Accept: 'application/json' } });
      if (r.status === 401 && !utils.getTok()) throw new Error('401: דרוש hf_ token לדפדוף');
      if (!r.ok) { lastErr = new Error(`שגיאת רשת (${r.status}) בדפדוף`); continue; }
      const j = await r.json();
      return filterImmediate(extractItems(j), path || '');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('שגיאה בדפדוף');
}

async function loadFolders() {
  els.folders.innerHTML = '<div class="hint">טוען תיקיות…</div>';
  try {
    const items = await listTree('');
    const dirs = items
      .filter(x => (x.type === 'directory' || x.type === 'tree' || x.type === 'dir'))
      .map(x => x.path.split('/').pop())
      .sort((a, b) => a.localeCompare(b, 'he'));
    els.folders.innerHTML = dirs.map(d => `<button class="item" data-folder="${d}">${d}</button>`).join('');
    // nudge scroll once content is in place
    setTimeout(nudgeFoldersOnce, 300);
  } catch (e) {
    els.folders.innerHTML = `<div class="err">${e.message || e}</div>`;
  }
}

function markFile(filePath, hasCorrection) {
  const fileName = filePath.split('/').pop();
  const el = els.files.querySelector(`[data-file="${fileName}"]`);
  if (!el) return;
  //el.style.background = hasCorrection ? 'rgba(0,255,0,.08)' : 'rgba(255,0,0,.08)';
}

async function fetchCorrections(filePaths) {
  const out = [];
  const chunk = 50;
  for (let i = 0; i < filePaths.length; i += chunk) {
    const part = filePaths.slice(i, i + chunk);
    const { data, error } = await supa.from('corrections').select('file_path').in('file_path', part);
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

async function loadAllCorrections() {
  try {
    const { data, error } = await supa.from('corrections').select('file_path');
    if (error) throw error;
    state.correctionsCache = new Set((data || []).map(r => r.file_path));
    console.log('✅ Corrections loaded:', state.correctionsCache.size);
  } catch (e) {
    console.error('❌ Failed to load corrections:', e.message || e);
  }
}

async function selectFolder(folder, node) {
  // highlight
  [...els.folders.children].forEach(el => el.classList.toggle('active', el === node));
  els.files.innerHTML = '<div class="hint">טוען קבצים…</div>';

  try {
    const items = await listTree(folder);
    const files = items
      .filter(x => {
        const t = (x.type || '').toLowerCase();
        const p = x.path || '';
        return (t === 'file' || t === 'blob' || t === 'lfs' || p.toLowerCase().endsWith('.opus'));
      })
      .map(x => (x.path || '').split('/').pop())
      .sort((a, b) => a.localeCompare(b, 'he'));

    if (!files.length) {
      els.files.innerHTML = '<div class="hint">אין קבצי OPUS בתיקייה זו</div>';
      return;
    }
    els.files.innerHTML = files.map(f => {
      const display = f.replace(/\.opus$/i, '');
      return `<button class="item" data-folder="${folder}" data-file="${f}">${display}</button>`;
    }).join('');

    files.forEach(f => markFile(folder + '/' + f, state.correctionsCache.has(folder + '/' + f)));
  } catch (e) {
    els.files.innerHTML = `<div class="err">${e.message || e}</div>`;
  }
}

async function selectEpisode(folder, file, node) {
  if (node) {
    if (state.currentFileNode) state.currentFileNode.classList.remove('active');
    state.currentFileNode = node;
    state.currentFileNode.classList.add('active');
  }
  const { audioPath, trPath } = utils.normPaths(folder, file);
  await load(audioPath, trPath);
}

async function load(audioPath, trPath) {
  if (state.currentFileNode) state.currentFileNode.classList.add('loading');
  const token = ++state.lastLoad.token;
  state.lastLoad.controller?.abort();
  const ac = new AbortController();
  state.lastLoad.controller = ac;

  try {
    utils.clearTranscript();
    state.undoStack = [];
    state.redoStack = [];

    // 1) try correction from DB
    let corrected = null;
    try {
      const { data, error } = await supa
        .from('corrections')
        .select('json_data')
        .eq('file_path', audioPath)
        .maybeSingle();
      if (!error && data) {
        corrected = data.json_data;
        console.log('✅ Loaded corrected JSON from Supabase');
        markFile(audioPath, true);
      }
    } catch (dbErr) { console.warn('Supabase query failed:', dbErr); }

    if (token !== state.lastLoad.token) return;

    // 2) fetch HF baseline (for diff)
    let hfRaw = null;
    try {
      const trUrl = utils.transUrl(trPath);
      let r = await utils.fetchAuth(trUrl, { signal: ac.signal });
      if (r.status === 401 && !utils.getTok()) throw new Error('401: דרוש hf_ token לתמליל');
      if (!r.ok) throw new Error(`שגיאת רשת (${r.status}) בתמליל`);

      let txt;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/gzip') || trPath.endsWith('.gz')) {
        const ab = await r.arrayBuffer();
        // use your existing ungzip (pako/ungzip) helper
        txt = new TextDecoder('utf-8').decode(ungzip(new Uint8Array(ab)));
      } else {
        txt = await r.text();
      }
      hfRaw = JSON.parse(txt);
    } catch (e) {
      console.warn('HF transcript fetch failed (diff baseline):', e);
    }
    if (token !== state.lastLoad.token) return;

    // 3) build baseline diff text
    if (hfRaw) {
      const hfNorm = normData(hfRaw);
      const hfTokens = flattenToTokens(hfNorm).map(t => ({ word: t.word, start: t.start, end: t.end, state: 'keep' }));
      state.hfBaselineText = wordsToText(hfTokens);
    } else {
      state.hfBaselineText = '';
    }

    // 4) choose active data
    if (corrected) {
      state.data = normData(corrected);
    } else {
      if (!hfRaw) throw new Error('שגיאה: כנראה לא הכנסת טוקן. לחץ על גלגל השיניים והכנס טוקן.');
      state.data = normData(hfRaw);
      markFile(audioPath, false);
    }

    // 5) tokens
    state.baselineTokens = flattenToTokens(state.data);
    state.currentTokens = state.baselineTokens.map(({ word, start, end, probability }) => ({
      word, start, end, probability, state: 'keep'
    }));
    repairChronology(state.currentTokens);

    state.data = tokensToData(state.currentTokens);

    // Render transcript + diff
    render();
    renderDiff();

    // Paint confirmations and sync DB-based marks to current text
    if (token !== state.lastLoad.token) return;
    if (typeof confirm !== 'undefined' && confirm?.refreshForCurrentFile) {
      await confirm.refreshForCurrentFile();
    } else {
      // At least paint once if confirm module isn't loaded
      (typeof confirm !== 'undefined' && confirm?.applyHighlights) && confirm.applyHighlights();
    }

    if (token !== state.lastLoad.token) return;

    // 6) audio
    const aUrl = utils.opusUrl(audioPath);
    if (utils.getTok() && utils.isHf(aUrl)) {
      const ar = await utils.fetchAuth(aUrl, { signal: ac.signal });
      if (ar.status === 401) throw new Error('401: דרוש hf_ token לאודיו');
      if (!ar.ok) throw new Error(`שגיאה (${ar.status}) באודיו`);
      const b = await ar.blob();
      if (state.objUrl) URL.revokeObjectURL(state.objUrl);
      state.objUrl = URL.createObjectURL(b);
      els.player.src = state.objUrl;
    } else {
      els.player.src = aUrl;
    }

    if (token !== state.lastLoad.token) return;

    els.player.playbackRate = parseFloat(els.rate.value) || 1;
    els.player.currentTime = 0.01;
  } catch (e) {
    if (e.name !== 'AbortError') alert(e.message || e);
  } finally {
    if (state.currentFileNode) state.currentFileNode.classList.remove('loading');
  }
}

/* =========================
   VTT / JSON export
   ========================= */
function buildVtt() {
  // simple: 1 cue per segment
  const segs = state.data.segments || [];
  let out = 'WEBVTT\n\n';
  segs.forEach((seg, i) => {
    out += `${i + 1}\n${utils.t2(seg.start || 0)} --> ${utils.t2(seg.end || (seg.start || 0) + .25)}\n${seg.text || ''}\n\n`;
  });
  return out;
}

// JSON includes per-word probabilities
function buildJson() {
  return JSON.stringify(state.data, null, 2);
}

/* =========================
   UI Functions
   ========================= */
const ui = {
  _pendingRebuild: false,
  _composing: false,

  requestRebuildFromTranscript() {
    if (ui._composing) return;         // defer until composition ends
    if (ui._pendingRebuild) return;
    ui._pendingRebuild = true;
    requestAnimationFrame(() => {
      ui._pendingRebuild = false;
      ui.rebuildFromTranscriptNow();
    });
  },

  rebuildFromTranscriptNow() {
    const el = els?.transcript || els?.transcript;
    if (!el) return;

    // 1) read current plain text + selection
    const beforeSel = utils.getSelectionOffsets(el);
    const newText = utils.plainText(el);

    // 2) rebuild tokens against baseline
    try {
      state.undoStack.push(handlers.snapshot());
      state.redoStack.length = 0;
      state.currentTokens = dataProcessing.buildFromBaseline(state.baselineTokens, newText);
      state.data = dataProcessing.tokensToData(state.currentTokens);
    } catch (err) {
      console.error('rebuildFromTranscript failed:', err);
      return;
    }

    // 3) re-render spans and highlights
    render();            // rebuild <span class="word">
    renderDiff?.();      // optional: keep diff live
    probHighlight?.apply?.();
    applyConfirmationHighlights?.();

    // 4) restore selection
    if (beforeSel) utils.setSelectionByOffsets(el, beforeSel[0], beforeSel[1]);
  },
};
/* =========================
   UI behaviors
   ========================= */
function readInitialTextSizeRem() {
  const saved = parseFloat(localStorage.getItem(LS_TEXTSZ));
  if (Number.isFinite(saved)) return saved;
  // fallback from transcript computed px
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const trPx = parseFloat(getComputedStyle($('#transcript') || document.body).fontSize) || (1.1 * px);
  return trPx / px;
}
function applyFontSize() {
  root.style.setProperty('--text-size', state.fontSizeRem.toFixed(2) + 'rem');
  if (state.editBox) state.editBox.style.fontSize = state.fontSizeRem.toFixed(2) + 'rem';
  localStorage.setItem(LS_TEXTSZ, String(state.fontSizeRem));
}

function setupPlayerAndControls() {
  // rate label init
  els.rateVal.textContent = '×' + (parseFloat(els.rate.value) || 1).toFixed(2);

  els.player.addEventListener('ratechange', () => {
    els.rate.value = String(els.player.playbackRate);
    els.rateVal.textContent = '×' + els.player.playbackRate.toFixed(2);
  });
  els.rate.oninput = () => {
    els.player.playbackRate = parseFloat(els.rate.value) || 1;
    els.rateVal.textContent = '×' + els.player.playbackRate.toFixed(2);
  };

  els.fontPlus.onclick = () => { state.fontSizeRem = Math.min(state.fontSizeRem + 0.10, 2.00); applyFontSize(); };
  els.fontMinus.onclick = () => { state.fontSizeRem = Math.max(state.fontSizeRem - 0.10, 0.60); applyFontSize(); };

  // probability toggle
  const probBtn = els.probToggle;
  if (probBtn) {
    function setProbUI() {
      probBtn.setAttribute('aria-pressed', String(state.probEnabled));
      probBtn.textContent = state.probEnabled ? 'בטל הדגשה' : 'הדגש ודאות נמוכה';
    }
    // init from localStorage (default ON)
    {
      const saved = localStorage.getItem('probHL');
      state.probEnabled = (saved == null) ? true : (saved !== 'off');
    }
    setProbUI();

    // capture the click so no other handler can swallow it;
    // also prevent default so it never submits a form, etc.
    probBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      state.probEnabled = !state.probEnabled;
      localStorage.setItem('probHL', state.probEnabled ? 'on' : 'off');
      setProbUI();
      applyProbHighlights(); // repaint spans in-place
    }, { capture: true });


    let _rafId = null;
    function _loop() {
      _rafId = null;
      tick();
      if (!els.player.paused && !els.player.ended) {
        _rafId = requestAnimationFrame(_loop);
      }
    }
    els.player.addEventListener('play', () => {
      if (!_rafId) _rafId = requestAnimationFrame(_loop);
    });
    els.player.addEventListener('pause', () => {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    });
    els.player.addEventListener('ended', () => {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    });

  }


  // =========================
  //   Modeless editing setup
  // =========================
  if (els.transcript) {
    // prefer plaintext-only if supported; otherwise fallback to true
    try {
      els.transcript.setAttribute('contenteditable', 'plaintext-only');
    } catch {
      els.transcript.setAttribute('contenteditable', 'true');
    }

    // keep default typing caret, avoid blue selection inversion from .word styles
    els.transcript.style.caretColor = 'var(--accent)';

    // capture caret BEFORE browser mutates DOM so we can restore after re-render
    els.transcript.addEventListener('beforeinput', () => {
      const sel = getSelectionOffsetsInTranscript();
      state._pendingCaret = sel ? sel[0] : null;
    });

    // ===== IME guard =====
    els.transcript.addEventListener('compositionstart', () => {
      state.composing = true;
    });
    els.transcript.addEventListener('compositionend', () => {
      state.composing = false;
      // after IME finishes, sync immediately
      renderDiff(utils.plainText(els.transcript));
      scheduleModelSync(0);
    });

    // ===== Live typing =====
    els.transcript.addEventListener('input', () => {
      if (state.composing) return; // let composition finish
      const live = utils.plainText(els.transcript);

      // keep the source-of-truth text in state (useful for exports)
      state.data.text = live;

      // update diff immediately
      renderDiff(live);

      // delay the heavy retokenize + spans rebuild
      scheduleModelSync(180);

      // optional: update confirm toolbar
      confirm?.updateButtons?.();
    });

    // keep confirm toolbar state fresh as user changes selection
    ['keyup', 'mouseup'].forEach(ev =>
      els.transcript.addEventListener(ev, () => {
        confirm?.updateButtons?.();
      })
    );

    // ===== On blur, make sure we are in sync =====
    els.transcript.addEventListener('blur', () => {
      if (state.composing) return;
      scheduleModelSync(0);
    });
  }


  // open -> focus the token input
  els.settingsBtn?.addEventListener('click', () => {
    els.modal.classList.add('open');
    els.hfToken.value = utils.getTok();
    requestAnimationFrame(() => els.hfToken?.focus());
  });

  // click outside to close (you already have this; keep it)
  els.modal?.addEventListener('click', (e) => {
    if (e.target === els.modal) els.modal.classList.remove('open');
  });

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.modal.classList.contains('open')) {
      els.modal.classList.remove('open');
    }
  });

  // save/clear remain the same; make sure null checks exist
  els.mSave?.addEventListener('click', () => {
    utils.setTok(els.hfToken.value.trim());
    els.modal.classList.remove('open');
  });
  els.mClear?.addEventListener('click', () => {
    utils.setTok('');
    els.hfToken.value = '';
  });
  els.mClose?.addEventListener('click', () => els.modal.classList.remove('open'));


  els.dlVtt.onclick = () => {
    const blob = new Blob([buildVtt()], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (document.title || 'transcript') + '.vtt'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // probability toggle (optional)
  if (els.probToggle) {
    els.probToggle.setAttribute('aria-pressed', String(state.probEnabled));
    els.probToggle.addEventListener('click', () => {
      state.probEnabled = !state.probEnabled;
      localStorage.setItem(LS_PROBHL, state.probEnabled ? 'on' : 'off');
      els.probToggle.setAttribute('aria-pressed', String(state.probEnabled));
      applyProbHighlights();
    });
  }
}

// Upper-bound by start times: returns index of the last word with start <= t
function indexByStart(t) {
  let lo = 0, hi = state.starts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.starts[mid] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function tick() {
  if (!state.wordEls.length || state.editingFull?.active) return;

  const t = els.player.currentTime;

  // --- find candidate index ---
  let i = indexByStart(t);
  if (i < 0) i = 0;

  // if we're not actually in range, fallback to old-style search
  if (!(t >= state.starts[i] && t <= state.ends[i])) {
    const next = i + (t > state.ends[i] ? 1 : -1);
    if (next >= 0 && next < state.starts.length && t >= state.starts[next] && t <= state.ends[next]) {
      i = next;
    } else {
      i = state.starts.findIndex((s, k) => t >= s && t <= state.ends[k]);
    }
  }

  if (i === state.lastIdx) return;

  // clear previous
  if (state.lastIdx >= 0) {
    const prevEl = state.wordEls[state.lastIdx];
    if (prevEl) {
      prevEl.classList.remove('active', 'confirmed-active');

      // restore its probability alpha (since it's no longer active)
      const pPrev = parseFloat(prevEl.dataset.prob);
      const baseAlpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prob-alpha')) || 0.6;
      let aPrev = 0;
      if (state.probEnabled && Number.isFinite(pPrev) && pPrev < PROB_THRESH) {
        aPrev = utils.clamp01((1 - pPrev) * baseAlpha);
      }
      prevEl.style.setProperty('--prob-a', String(aPrev));
    }
  }

  // set current
  const el = state.wordEls[i];
  if (el) {
    el.classList.add('active');
    if (el.classList.contains('confirmed')) el.classList.add('confirmed-active');

    // suppress prob alpha so active bg is visible
    el.style.setProperty('--prob-a', '0');

    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  state.lastIdx = i;
}



/* transcript interactions */
// Alt+click a word to seek to its start (so normal clicks stay for editing)
els.transcript.addEventListener('click', (e) => {
  if (!e.altKey) return;
  const el = e.target.closest('.word');
  if (!el) return;
  const t = +el.dataset.start;
  if (Number.isFinite(t)) {
    els.player.currentTime = t + .01;
    try { els.player.play(); } catch { }
    e.preventDefault();
  }
});
// IME-safe composition gating
els.transcript.addEventListener('compositionstart', () => { ui._composing = true; });
els.transcript.addEventListener('compositionend', () => { ui._composing = false; ui.requestRebuildFromTranscript(); });

// Rebuild only on real text changes
els.transcript.addEventListener('input', (e) => {
  // Only handle text-affecting inputs; ignore pure selection changes
  ui.requestRebuildFromTranscript();
});

/* Undo/redo */
document.addEventListener('keydown', (e) => {
  const isZ = (e.code === 'KeyZ');
  const isUndo = (e.ctrlKey || e.metaKey) && isZ && !e.shiftKey;
  const isRedo = (e.ctrlKey || e.metaKey) && isZ && e.shiftKey;

  if (isUndo) {
    e.preventDefault();
    if (state.undoStack.length) {
      state.redoStack.push(snapshot());
      state.currentTokens = state.undoStack.pop();
      state.data = tokensToData(state.currentTokens);
      render();
      if (state.editBox) state.editBox.textContent = getFullText();
      renderDiff();
    }
  } else if (isRedo) {
    e.preventDefault();
    if (state.redoStack.length) {
      state.undoStack.push(snapshot());
      state.currentTokens = state.redoStack.pop();
      state.data = tokensToData(state.currentTokens);
      render(); renderDiff();
      if (state.editBox) state.editBox.textContent = getFullText();
    }
  }
});

/* Save to DB */
els.submitBtn?.addEventListener('click', async () => {
  try {
    if (!validateChronology(state.currentTokens)) return;
    const json = JSON.parse(buildJson());
    const filePath = state.currentFileNode
      ? state.currentFileNode.dataset.folder + '/' + state.currentFileNode.dataset.file
      : null;

    if (!filePath) { alert('אין קובץ נבחר'); return; }

    const { data, error } = await supa
      .from('corrections')
      .upsert({ file_path: filePath, json_data: json }, { onConflict: 'file_path' })
      .select();

    if (error) throw error;
    await loadAllCorrections();
    alert('✅ נשמר בהצלחה למסד הנתונים!');
    const el = els.files.querySelector(`[data-file="${state.currentFileNode.dataset.file}"]`);
    if (el) el.style.background = 'rgba(0,255,0,.08)';
  } catch (e) {
    console.error(e);
    alert('❌ שגיאה בשמירת תיקון: ' + (e.message || e));
  }
});

/* =========================
   Chronology check
   ========================= */
function validateChronology(tokens) {
  let prevStart = -Infinity;
  const issues = [];
  tokens.forEach((t, i) => {
    if (t.state === 'del' || t.word === '\n') return;
    const s = t.start, e = t.end;
    const label = `${i}:${JSON.stringify(t.word)}`;
    if (!Number.isFinite(s) || !Number.isFinite(e)) { issues.push(`NaN time at ${label}`); return; }
    if (e < s - EPS) issues.push(`end<start at ${label} (${s}→${e})`);
    if (s < prevStart - EPS) issues.push(`non-monotonic start at ${label} (${s} < prev ${prevStart})`);
    prevStart = Math.max(prevStart, s);
  });
  if (issues.length) {
    console.error('⛔ Token chronology issues:\n' + issues.join('\n'));
    alert('בעיית כרונולוגיה בזמנים:\n' + issues.slice(0, 20).join('\n') + (issues.length > 20 ? `\n…ועוד ${issues.length - 20}` : ''));
    return false;
  }
  return true;
}

/* =========================
   Scroll sync (two-way)
   ========================= */
function setupScrollSync() {
  const trScroll = document.querySelector('#transcriptCard .body') || els.transcript;
  const diffScroll = document.querySelector('#diffCard .body') || els.diffBody;
  if (!trScroll || !diffScroll) return;

  let lock = 0;
  const sync = (src, dst) => {
    if (lock) return;
    lock = 1;
    const srcMax = Math.max(1, src.scrollHeight - src.clientHeight);
    const dstMax = Math.max(1, dst.scrollHeight - dst.clientHeight);
    dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
    // let the browser process paint before unlocking to avoid ping-pong
    requestAnimationFrame(() => { lock = 0; });
  };

  trScroll.addEventListener('scroll', () => sync(trScroll, diffScroll), { passive: true });
  diffScroll.addEventListener('scroll', () => sync(diffScroll, trScroll), { passive: true });
}

/* =========================
   Gutters (drag + persist)
   ========================= */
function setupGutters() {
  const panel = els.panel, gutL = els.gutterL, gutR = els.gutterR;
  if (!panel || !gutL || !gutR) return;

  // restore saved widths
  const wNav = parseFloat(localStorage.getItem(LS_W_NAV));
  const wDiff = parseFloat(localStorage.getItem(LS_W_DIFF));
  if (Number.isFinite(wNav)) panel.style.setProperty('--w-nav', wNav + 'px');
  if (Number.isFinite(wDiff)) panel.style.setProperty('--w-diff', wDiff + 'px');

  let dragging = null;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function onMove(e) {
    if (!dragging) return;
    const x = e.clientX;
    if (dragging.which === 'L') {
      // left gutter controls DIFF width
      let newW;
      if (dragging.diffIsLeftOfGutter) {
        newW = clamp(x - dragging.panelRect.left, 3, 640);
      } else {
        newW = clamp(dragging.panelRect.right - x, 3, 640);
      }
      panel.style.setProperty('--w-diff', newW + 'px');
      localStorage.setItem(LS_W_DIFF, String(newW));
    } else {
      // right gutter controls NAV width
      let newW;
      if (dragging.browserIsRightOfGutter) {
        newW = clamp(dragging.panelRect.right - x, 3, 680);
      } else {
        newW = clamp(x - dragging.panelRect.left, 3, 680);
      }
      panel.style.setProperty('--w-nav', newW + 'px');
      localStorage.setItem(LS_W_NAV, String(newW));
    }
  }
  function stop() {
    if (!dragging) return;
    document.body.style.userSelect = dragging.prevUserSelect || '';
    dragging = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  }
  function start(which, e) {
    const panelRect = panel.getBoundingClientRect();
    if (which === 'L') {
      const gutRect = gutL.getBoundingClientRect();
      const diffRect = ($('#diffCard') || panel).getBoundingClientRect();
      dragging = {
        which, panelRect,
        prevUserSelect: document.body.style.userSelect,
        diffIsLeftOfGutter: diffRect.left < gutRect.left
      };
    } else {
      const gutRect = gutR.getBoundingClientRect();
      const brRect = ($('#browserCard') || panel).getBoundingClientRect();
      dragging = {
        which, panelRect,
        prevUserSelect: document.body.style.userSelect,
        browserIsRightOfGutter: brRect.right > gutRect.right
      };
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  }

  gutL.addEventListener('mousedown', (e) => { e.preventDefault(); start('L', e); });
  gutR.addEventListener('mousedown', (e) => { e.preventDefault(); start('R', e); });

  // keyboard nudges (optional)
  function nudge(which, dx) {
    const cs = getComputedStyle(panel);
    const prop = which === 'L' ? '--w-diff' : '--w-nav';
    const cur = parseFloat(cs.getPropertyValue(prop)) || (which === 'L' ? 360 : 380);
    const next = (which === 'L') ? clamp(cur + dx, 220, 640) : clamp(cur + dx, 240, 680);
    panel.style.setProperty(prop, next + 'px');
    localStorage.setItem(which === 'L' ? LS_W_DIFF : LS_W_NAV, String(next));
  }
  gutL.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nudge('L', -10);
    if (e.key === 'ArrowRight') nudge('L', 10);
  });
  gutR.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nudge('R', -10);
    if (e.key === 'ArrowRight') nudge('R', 10);
  });
}

/* =========================
   Folders auto-scroll nudge
   ========================= */
function nudgeFoldersOnce() {
  const el = els.folders;
  if (!el) return;
  if (el.scrollHeight <= el.clientHeight + 1) return; // no overflow

  // cancel on user interaction
  let cancelled = false;
  const cancel = () => { cancelled = true; cleanup(); };
  const cleanup = () => {
    el.removeEventListener('wheel', cancel, { passive: true });
    el.removeEventListener('touchstart', cancel, { passive: true });
    el.removeEventListener('pointerdown', cancel, { passive: true });
    el.removeEventListener('keydown', cancel);
    el.removeEventListener('scroll', cancel, { passive: true });
  };
  el.addEventListener('wheel', cancel, { passive: true });
  el.addEventListener('touchstart', cancel, { passive: true });
  el.addEventListener('pointerdown', cancel, { passive: true });
  el.addEventListener('keydown', cancel);
  el.addEventListener('scroll', cancel, { passive: true });

  // jump to bottom, then animate to top in 1.5s (ease-in-out)
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight - el.clientHeight;
  el.style.scrollBehavior = prev;

  const from = el.scrollTop;
  const to = 0;
  const dur = 1500;
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

  function step(now) {
    if (cancelled) return;
    const p = Math.min(1, (now - t0) / dur);
    el.scrollTop = from + (to - from) * ease(p);
    if (p < 1) requestAnimationFrame(step);
    else cleanup();
  }
  requestAnimationFrame(step);
}

/* =========================
   Init
   ========================= */
function init() {
  setupPlayerAndControls();
  applyFontSize();
  setupScrollSync();
  setupGutters();

  // browser events
  els.folders.addEventListener('click', (e) => {
    const item = e.target.closest('.item[data-folder]');
    if (item) selectFolder(item.dataset.folder, item);
  });
  els.files.addEventListener('click', (e) => {
    const item = e.target.closest('.item[data-file]');
    if (item) selectEpisode(item.dataset.folder, item.dataset.file, item);
  });

  // load sidebar + corrections
  loadFolders().catch(console.error);
  loadAllCorrections().catch(console.error);

  // revoke blob URL on unload
  window.addEventListener('beforeunload', () => {
    if (state.objUrl) try { URL.revokeObjectURL(state.objUrl); } catch { }
  });

  confirm.setupButtons();
}


(function setupThemeToggle() {
  const root = document.documentElement; // <html>
  const toggleBtn = document.getElementById("themeToggle");
  const themeIcon = document.getElementById("themeIcon");


  if (!toggleBtn || !themeIcon) return;

  function applyTheme(mode) {
    if (mode === "dark") {
      root.classList.add("theme-dark");   // <html class="theme-dark">
      themeIcon.textContent = "☀️";
    } else {
      root.classList.remove("theme-dark");
      themeIcon.textContent = "🌙";
    }
    localStorage.setItem("theme", mode);
  }

  const saved = localStorage.getItem('theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ? saved : (prefersDark ? 'dark' : 'light'));

  toggleBtn.addEventListener("click", () => {
    const isDark = root.classList.contains("theme-dark");
    applyTheme(isDark ? "light" : "dark");
  });

})();


init();
