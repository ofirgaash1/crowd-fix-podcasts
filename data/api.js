// v2/data/api.js
// Minimal, production-safe loader for v2. Read-only for now (HF or Supabase 'corrections').

import { store } from '../core/state.js';

/* ========= Config ========= */
const SUPABASE_URL = window?.SUPABASE_URL || window?.supabaseUrl || null;
const SUPABASE_KEY = window?.SUPABASE_KEY || window?.supabaseKey || null;

// optional supabase client (if you already include supabase-js globally)
const hasSupabase = typeof window !== 'undefined' && !!window.supabase && !!SUPABASE_URL && !!SUPABASE_KEY;
const supa = hasSupabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/* ========= Helpers ========= */
function getTok() { try { return localStorage.getItem('hfToken') || ''; } catch { return ''; } }
function isHf(u) { try { const h = new URL(u).host; return h.endsWith('huggingface.co') || h.endsWith('hf.co'); } catch { return false; } }
function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
function hfRes(path, ds) { return `https://huggingface.co/datasets/ivrit-ai/${ds}/resolve/main/${encPath(path)}`; }
function opusUrl(path) { return hfRes(path, 'audio-v2-opus'); }
function transUrl(path) { return hfRes(path, 'audio-v2-transcripts'); }
function normPaths(folder, file) {
  return {
    audioPath: `${folder}/${file}`,
    trPath: `${folder}/${file.replace(/\.opus$/i, '')}/full_transcript.json.gz`,
  };
}
async function fetchAuth(u, o = {}) {
  const h = new Headers(o.headers || {});
  if (!h.has('Accept')) h.set('Accept', 'application/json');
  const tok = getTok();
  if (tok && isHf(u)) h.set('Authorization', 'Bearer ' + tok);
  return fetch(u, { ...o, headers: h, mode: 'cors', redirect: 'follow' });
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
        if (w.hasOwnProperty('probability')) w.probability = +w.probability;
      });
    }
  });
  return d;
}

function flattenToTokens(d) {
  const toks = []; let lastEnd = 0;
  d.segments.forEach((s, si) => {
    s.words.forEach(w => {
      toks.push({
        word: String(w.word || ''),
        start: +w.start || 0,
        end: +w.end || ((+w.start || 0) + .25),
        probability: Number.isFinite(+w.probability) ? +w.probability : undefined,
      });
      lastEnd = toks[toks.length - 1].end;
    });
    if (si < d.segments.length - 1) {
      toks.push({ word: '\n', start: lastEnd, end: lastEnd, probability: undefined });
    }
  });
  return toks;
}

/* ========= Public API ========= */

/**
 * Load a transcript by HF folder/file (read-only).
 * Returns: { filePath, text, tokens, versionMeta }
 */
export async function loadFromHuggingFace(folder, file) {
  const { trPath } = normPaths(folder, file);

  let hfRaw = null;
  // 1) fetch HF JSON (gz or plain)
  {
    const url = transUrl(trPath);
    const r = await fetchAuth(url);
    if (r.status === 401 && !getTok()) throw new Error('401: דרוש hf_ token לתמליל');
    if (!r.ok) throw new Error(`שגיאה (${r.status}) בתמליל`);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let txt;
    if (ct.includes('application/gzip') || trPath.endsWith('.gz')) {
      if (!window.pako) throw new Error('pako (gzip) לא נטען');
      const ab = await r.arrayBuffer();
      txt = new TextDecoder('utf-8').decode(window.pako.ungzip(new Uint8Array(ab)));
    } else {
      txt = await r.text();
    }
    hfRaw = JSON.parse(txt);
  }

  // 2) normalize -> tokens
  const data = normData(hfRaw);
  const tokens = flattenToTokens(data);

  // 3) version meta for read-only HF source: use a deterministic hash so confirmations can bind.
  const base_sha256 = await sha256(data.text);
  const versionMeta = {
    version: base_sha256.slice(0, 12), // pseudo-version for HF baseline
    base_sha256,
    file_path: `${folder}/${file}`,
  };

  return {
    filePath: versionMeta.file_path,
    text: data.text,
    tokens,
    versionMeta,
  };
}

/**
 * Optionally load a corrected JSON from Supabase if present, else fall back to HF.
 * Returns the *effective* version (correction if exists).
 */
export async function loadPreferCorrection(folder, file) {
  const file_path = `${folder}/${file}`;
  let corrected = null;

  if (supa) {
    try {
      const { data, error } = await supa
        .from('corrections')
        .select('json_data')
        .eq('file_path', file_path)
        .maybeSingle();
      if (!error && data) corrected = data.json_data;
    } catch (e) {
      console.warn('Supabase corrections fetch failed:', e);
    }
  }

  if (corrected) {
    const data = normData(corrected);
    const tokens = flattenToTokens(data);
    const base_sha256 = await sha256(data.text);
    return {
      filePath: file_path,
      text: data.text,
      tokens,
      versionMeta: {
        version: base_sha256.slice(0, 12),
        base_sha256,
        file_path,
      },
    };
  }

  // fallback to HF
  return loadFromHuggingFace(folder, file);
}

/* ========= tiny crypto ========= */
async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
