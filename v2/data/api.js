// v2/data/api.js
// Data access + normalization (HF baseline + optional Supabase corrections).
// Zero UI here—just fetch, normalize, and hand back clean structures.

// ---- Optional Supabase client (pass from your app) ----
let supa = null;
let correctionsCache = new Set();

/**
 * Configure Supabase. Call once from app bootstrap:
 *   import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
 *   api.configureSupabase(createClient(SUPABASE_URL, ANON_KEY));
 */
export function configureSupabase(client) {
  supa = client || null;
  if (supa) {
    loadAllCorrections();
  }
}

/**
 * Load all corrections from Supabase to cache
 */
async function loadAllCorrections() {
  if (!supa) return;
  
  try {
    const { data, error } = await supa.from('corrections').select('file_path');
    if (error) throw error;
    correctionsCache = new Set((data || []).map(r => r.file_path));
    console.log('✅ Corrections loaded:', correctionsCache.size);
  } catch (e) {
    console.error('❌ Failed to load corrections:', e.message || e);
  }
}

/**
 * Check if a file has corrections
 */
export function hasCorrection(filePath) {
  return correctionsCache.has(filePath);
}

// ---- HF auth token helpers (read from localStorage like v1) ----
const TOKEN_KEY = 'hfToken';
function getHFToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

// ---- Hugging Face URL helpers ----
const DATASET = 'ivrit-ai';
const DS_AUDIO = 'audio-v2-opus';
const DS_TRANS = 'audio-v2-transcripts';

function encPath(p) { return String(p || '').split('/').map(encodeURIComponent).join('/'); }
function hfRes(path, ds) {
  return `https://huggingface.co/datasets/${DATASET}/${ds}/resolve/main/${encPath(path)}`;
}
function opusUrl(path) { return hfRes(path, DS_AUDIO); }
function transUrl(path) { return hfRes(path, DS_TRANS); }
function normPaths(folder, file) {
  const audioPath = `${folder}/${file}`;
  const trPath = `${folder}/${file.replace(/\.opus$/i, '')}/full_transcript.json.gz`;
  return { audioPath, trPath };
}

// ---- Folder/File listing helpers ----
function hfApiUrl(path, ds) {
  const base = `https://huggingface.co/api/datasets/${DATASET}/${ds}/tree/main`;
  if (!path) return [base, `${base}?recursive=false`];
  return [
    `${base}/${encPath(path)}`,
    `${base}?path=${encodeURIComponent(path)}`
  ];
}

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

// ---- Fetch with HF auth if available ----
async function fetchHF(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const tok = getHFToken();
  // Only add Authorization for HF hosts
  try {
    const host = new URL(url).host;
    if (tok && (host.endsWith('huggingface.co') || host.endsWith('hf.co'))) {
      headers.set('Authorization', 'Bearer ' + tok);
    }
  } catch {}
  return fetch(url, { ...init, headers, mode: 'cors', redirect: 'follow' });
}

// ---- Gzip decode (DecompressionStream with pako fallback) ----
async function decodeMaybeGzip(response, originalUrl = '') {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  const isGz = ct.includes('application/gzip') || /\.gz($|\?)/i.test(originalUrl);

  // Plain JSON
  if (!isGz) return response.text();

  // Streaming decode if supported
  if (typeof DecompressionStream !== 'undefined' && response.body) {
    const ds = new DecompressionStream('gzip');
    const stream = response.body.pipeThrough(ds);
    const decompressed = await new Response(stream).text();
    return decompressed;
  }

  // Fallback: dynamic import pako
  const { default: pako } = await import('https://esm.sh/pako@2.1.0');
  const buf = await response.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(pako.ungzip(new Uint8Array(buf)));
  return text;
}

// ---- Folder/File listing functions ----
/**
 * List folders in the audio dataset
 * @returns {Promise<Array<{name: string, type: 'directory'}>>}
 */
export async function listFolders() {
  const urls = hfApiUrl('', DS_AUDIO);
  let lastErr = null;

  for (const url of urls) {
    try {
      const response = await fetchHF(url);
      
      if (response.status === 401 && !getHFToken()) {
        throw new Error('401: נדרש טוקן Hugging Face כדי לטעון את רשימת התיקיות');
      }
      if (!response.ok) {
        lastErr = new Error(`שגיאת רשת (${response.status}) בעת טעינת רשימת תיקיות`);
        continue;
      }
      
      const data = await response.json();
      const items = extractItems(data);
      const dirs = filterImmediate(items, '')
        .filter(x => (x.type === 'directory' || x.type === 'tree' || x.type === 'dir'))
        .map(x => x.path.split('/').pop())
        .sort((a, b) => a.localeCompare(b, 'he'));
      
      return dirs.map(name => ({ name, type: 'directory' }));
    } catch (error) {
      lastErr = error;
    }
  }
  
  console.warn('Failed to list folders:', lastErr);
  throw lastErr || new Error('שגיאה בטעינת רשימת תיקיות');
}

/**
 * List audio files in a specific folder
 * @param {string} folder - folder name
 * @returns {Promise<Array<{name: string, type: 'file', size: number}>>}
 */
export async function listFiles(folder) {
  if (!folder) return [];
  
  const urls = hfApiUrl(folder, DS_AUDIO);
  let lastErr = null;

  for (const url of urls) {
    try {
      const response = await fetchHF(url);
      
      if (response.status === 401 && !getHFToken()) {
        throw new Error('401: נדרש טוקן Hugging Face כדי לטעון את רשימת הקבצים');
      }
      if (!response.ok) {
        lastErr = new Error(`שגיאת רשת (${response.status}) בעת טעינת רשימת קבצים`);
        continue;
      }
      
      const data = await response.json();
      const items = extractItems(data);
      const files = filterImmediate(items, folder)
        .filter(x => {
          const t = (x.type || '').toLowerCase();
          const p = x.path || '';
          return (t === 'file' || t === 'blob' || t === 'lfs' || p.toLowerCase().endsWith('.opus'));
        })
        .map(x => (x.path || '').split('/').pop())
        .sort((a, b) => a.localeCompare(b, 'he'));
      
      return files.map(name => ({ 
        name, 
        type: 'file', 
        size: 0 
      }));
    } catch (error) {
      lastErr = error;
    }
  }
  
  console.warn('Failed to list files:', lastErr);
  throw lastErr || new Error('שגיאה בטעינת רשימת קבצים');
}

// ---- Normalization: transcript JSON → flat tokens -----------------
/**
 * Ensures segments/words exist and numbers are finite.
 * Preserves `probability` if present on words.
 */
function normalizeTranscript(raw) {
  const d = JSON.parse(JSON.stringify(raw || {}));
  d.text = d.text || '';
  d.segments = Array.isArray(d.segments) ? d.segments : [];

  d.segments.forEach((s) => {
    if (!Array.isArray(s.words) || !s.words.length) {
      s.words = [{
        word: s.text || ' ',
        start: +s.start || 0,
        end: +s.end || (+s.start || 0) + 0.5,
        probability: Number.isFinite(+s.probability) ? +s.probability : undefined
      }];
    } else {
      s.words.forEach((w) => {
        w.start = +w.start || 0;
        w.end = +w.end || (w.start + 0.25);
        w.word = String(w.word || '');
        if (w.probability != null) w.probability = Number(w.probability);
      });
    }
  });
  return d;
}

/** Flatten segments -> tokens with '\n' separators (keep probability) */
function flattenToTokens(d) {
  const toks = [];
  let lastEnd = 0;

  (d.segments || []).forEach((s, si) => {
    (s.words || []).forEach((w) => {
      toks.push({
        word: String(w.word || ''),
        start: +w.start || 0,
        end: +w.end || ((+w.start || 0) + 0.25),
        probability: Number.isFinite(+w.probability) ? +w.probability : NaN
      });
      lastEnd = toks[toks.length - 1].end;
    });
    if (si < (d.segments.length - 1)) {
      toks.push({ word: '\n', start: lastEnd, end: lastEnd, probability: NaN });
    }
  });

  return toks;
}

function wordsToText(tokens) {
  let s = '';
  for (const t of (tokens || [])) s += t.word;
  return s;
}

// ---- Supabase: corrections (optional) -----------------------------
async function loadCorrectionFromDB(filePath) {
  if (!supa) return null;
  const { data, error } = await supa
    .from('corrections')
    .select('json_data')
    .eq('file_path', filePath)
    .maybeSingle();

  if (error) {
    // Non-fatal: just log and return null
    console.warn('Supabase corrections fetch failed:', error);
    return null;
  }
  return data?.json_data || null;
}

/** Upsert correction JSON */
export async function saveCorrectionToDB(filePath, jsonObj) {
  if (!supa) throw new Error('Supabase client not configured');
  const { data, error } = await supa
    .from('corrections')
    .upsert({ file_path: filePath, json_data: jsonObj }, { onConflict: 'file_path' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ---- Public: load one episode (baseline + initial tokens + audio) ----
/**
 * Load an episode:
 *  - HF baseline transcript (for diff/align)
 *  - Optional DB correction (as current view)
 *  - Audio URL (token-aware)
 *
 * @param {{ folder:string, file:string }} param0
 * @returns {Promise<{
 *   audioUrl: string,
 *   baselineTokens: Array<{word:string,start:number,end:number,probability:number}>,
 *   baselineText: string,
 *   initialTokens: Array<{word:string,start:number,end:number,probability:number}>,
 *   usedCorrection: boolean
 * }>}
 */
export async function loadEpisode({ folder, file }) {
  if (!folder || !file) throw new Error('loadEpisode: folder and file are required');
  const { audioPath, trPath } = normPaths(folder, file);

  // 1) Try Supabase corrections first (optional)
  let correction = null;
  try {
    correction = await loadCorrectionFromDB(audioPath);
  } catch (e) {
    console.warn('Corrections lookup error:', e);
  }

  // 2) Always fetch HF baseline transcript (for diff/align baseline)
  const transcriptUrl = transUrl(trPath);
  const trResp = await fetchHF(transcriptUrl);
  if (trResp.status === 401 && !getHFToken()) {
    throw new Error('401: נדרש טוקן Hugging Face כדי לטעון את התמליל');
  }
  if (!trResp.ok) {
    throw new Error(`שגיאת רשת (${trResp.status}) בעת טעינת תמליל`);
  }
  const trText = await decodeMaybeGzip(trResp, transcriptUrl);
  const hfRaw = JSON.parse(trText);
  const hfNorm = normalizeTranscript(hfRaw);
  const baselineTokens = flattenToTokens(hfNorm);
  const baselineText = wordsToText(baselineTokens);

  // 3) Choose initial tokens (DB correction if present, else HF baseline)
  let initialTokens, usedCorrection = false;
  if (correction) {
    const corrNorm = normalizeTranscript(correction);
    initialTokens = flattenToTokens(corrNorm);
    usedCorrection = true;
  } else {
    initialTokens = baselineTokens;
    usedCorrection = false;
  }

  // 4) Audio URL (token-aware). If token present → fetch blob for auth-gated access.
  const audioHF = opusUrl(audioPath);
  let audioUrl = audioHF;
  try {
    const tok = getHFToken();
    const needsAuth = !!tok;
    if (needsAuth) {
      const r = await fetchHF(audioHF);
      if (r.status === 401) throw new Error('401: נדרש טוקן Hugging Face כדי לטעון אודיו');
      if (r.ok) {
        const b = await r.blob();
        audioUrl = URL.createObjectURL(b);
      }
    }
  } catch (e) {
    console.warn('Audio fetch (authorized) failed, falling back to direct URL:', e);
    // keep direct URL — may still work if public
  }

  return {
    audioUrl,
    baselineTokens,
    baselineText,
    initialTokens,
    usedCorrection
  };
}

// Named export bundle (matches earlier import style: `import { api } from ...`)
export const api = {
  configureSupabase,
  loadEpisode,
  saveCorrectionToDB,
  listFolders,
  listFiles,
  hasCorrection
};
export default api;
