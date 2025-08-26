// data.js
// ES module: data adapters (HuggingFace + Supabase)
// - Retries with jitter + AbortController support
// - No DOM access, no rendering
// - Emits plain objects; normalization happens in the model layer

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?target=es2022';
import { ungzip } from 'https://esm.sh/pako@2.1.0?target=es2022';

/** @typedef {{ id:number, file_path:string, base_sha256:string, start_offset?:number, end_offset?:number, prefix?:string, exact?:string, suffix?:string, created_at?:string }} Confirmation */
/** @typedef {{ file_path:string, json_data:any }} CorrectionRow */

const HF_HOST = 'https://huggingface.co';
const HF_API = `${HF_HOST}/api`;
const DEFAULT_DATASETS = {
  opus: 'ivrit-ai/audio-v2-opus',
  transcripts: 'ivrit-ai/audio-v2-transcripts',
};
const TOKEN_STORAGE_KEY = 'hfToken';

/* ----------------------------- small utilities ---------------------------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 20;
}

async function withRetries(fn, { retries = 2, baseDelay = 300, signal } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      if (isAbort(err)) throw err;
      if (attempt >= retries) throw err;
      const jitter = Math.random() * 120;
      await sleep(baseDelay * Math.pow(2, attempt) + jitter);
      attempt++;
    }
  }
}

function contentType(resp) {
  return (resp.headers.get('content-type') || '').toLowerCase();
}

function defaultTokenGetter() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
  catch { return ''; }
}

/* -------------------------------- HuggingFace ----------------------------- */

export class HuggingFaceClient {
  /**
   * @param {{ tokenGetter?: ()=>string, datasets?: { opus:string, transcripts:string } }} [opts]
   */
  constructor(opts = {}) {
    this.getToken = opts.tokenGetter || defaultTokenGetter;
    this.datasets = { ...DEFAULT_DATASETS, ...(opts.datasets || {}) };
  }

  /* ------------------------------- URL helpers ------------------------------ */

  /** URL to a dataset "resolve/main" file */
  resolveUrl(dataset, path) {
    return `${HF_HOST}/datasets/${dataset}/resolve/main/${encPath(path)}`;
  }

  /** Opus URL (public if repo is public; otherwise requires auth header) */
  opusUrl(audioPath) {
    return this.resolveUrl(this.datasets.opus, audioPath);
  }

  /** Transcript URL (gz or json) */
  transcriptUrl(trPath) {
    return this.resolveUrl(this.datasets.transcripts, trPath);
  }

  /** API tree endpoint (mirrors the website folder tree) */
  treeUrl(dataset, path = '', recursive = false) {
    const base = `${HF_API}/datasets/${dataset}/tree/main`;
    return path
      ? `${base}/${encPath(path)}`
      : recursive ? `${base}?recursive=false` : base;
  }

  /**
   * List immediate children under a path in the opus dataset.
   * @param {string} path folder path ('', 'folder', 'folder/sub')
   * @param {{signal?:AbortSignal}} [opt]
   * @returns {Promise<Array<{type:string,path:string,oid?:string}>>}
   */
  async listTree(path = '', opt = {}) {
    const urls = path
      ? [this.treeUrl(this.datasets.opus, path, false), `${this.treeUrl(this.datasets.opus)}?path=${encodeURIComponent(path)}`]
      : [this.treeUrl(this.datasets.opus), `${this.treeUrl(this.datasets.opus)}?recursive=false`];

    const token = this.getToken();
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', 'Bearer ' + token);

    // try both styles; return first that works
    let lastErr = null;
    for (const url of urls) {
      try {
        const data = await withRetries(async () => {
          const r = await fetch(url, { headers, mode: 'cors', redirect: 'follow', signal: opt.signal });
          if (r.status === 401 && !token) throw new Error('401: HuggingFace token required');
          if (!r.ok) throw new Error(`Tree fetch failed (${r.status})`);
          return await r.json();
        }, { retries: 1, signal: opt.signal });
        return this.#filterImmediate(this.#extractItems(data), path);
      } catch (e) {
        lastErr = e;
        if (isAbort(e)) throw e;
      }
    }
    throw lastErr || new Error('Tree fetch failed');
  }

  #extractItems(json) {
    if (Array.isArray(json)) return json;
    if (json?.items && Array.isArray(json.items)) return json.items;
    if (json?.tree && Array.isArray(json.tree)) return json.tree;
    if (json?.siblings && Array.isArray(json.siblings)) return json.siblings;
    return [];
  }

  #filterImmediate(items, base) {
    const depth = base ? base.split('/').filter(Boolean).length : 0;
    return items.filter(x => {
      const p = x.path || x.rpath || '';
      if (base && !p.startsWith(base + '/')) return false;
      const d = p.split('/').filter(Boolean).length;
      return d === depth + 1;
    });
  }

  /**
   * List folders under root (sorted, Hebrew-aware)
   * @param {{signal?:AbortSignal}} [opt]
   * @returns {Promise<string[]>}
   */
  async listFolders(opt = {}) {
    const items = await this.listTree('', opt);
    return items
      .filter(x => ['directory', 'tree', 'dir'].includes((x.type || '').toLowerCase()))
      .map(x => (x.path || '').split('/').pop())
      .sort((a, b) => a.localeCompare(b, 'he'));
  }

  /**
   * List .opus files within a folder.
   * @param {string} folder
   * @param {{signal?:AbortSignal}} [opt]
   * @returns {Promise<string[]>} filenames (with extension)
   */
  async listOpusFiles(folder, opt = {}) {
    const items = await this.listTree(folder, opt);
    const files = items
      .filter(x => {
        const t = (x.type || '').toLowerCase();
        const p = x.path || '';
        return (t === 'file' || t === 'blob' || t === 'lfs' || p.toLowerCase().endsWith('.opus'));
      })
      .map(x => (x.path || '').split('/').pop());
    return files.sort((a, b) => a.localeCompare(b, 'he'));
  }

  /**
   * Convert (folder,file.opus) to audio+transcript paths.
   * @param {string} folder
   * @param {string} file
   */
  normPaths(folder, file) {
    return {
      audioPath: `${folder}/${file}`,
      trPath: `${folder}/${file.replace(/\.opus$/i, '')}/full_transcript.json.gz`,
    };
  }

  /**
   * Fetch transcript JSON (gz or plain). Returns parsed JSON.
   * @param {string} trPath (e.g. "folder/name/full_transcript.json.gz")
   * @param {{signal?:AbortSignal}} [opt]
   */
  async fetchTranscript(trPath, opt = {}) {
    const url = this.transcriptUrl(trPath);
    const token = this.getToken();
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', 'Bearer ' + token);

    return withRetries(async () => {
      const r = await fetch(url, { headers, mode: 'cors', redirect: 'follow', signal: opt.signal });
      if (r.status === 401 && !token) throw new Error('401: HuggingFace token required for transcript');
      if (!r.ok) throw new Error(`Transcript fetch failed (${r.status})`);
      const ct = contentType(r);
      if (ct.includes('application/gzip') || trPath.endsWith('.gz')) {
        const ab = await r.arrayBuffer();
        const txt = new TextDecoder('utf-8').decode(ungzip(new Uint8Array(ab)));
        return JSON.parse(txt);
      } else {
        return await r.json();
      }
    }, { retries: 2, baseDelay: 300, signal: opt.signal });
  }

  /**
   * Fetch audio Blob (.opus). Caller may createObjectURL on it.
   * @param {string} audioPath
   * @param {{signal?:AbortSignal}} [opt]
   * @returns {Promise<Blob>}
   */
  async fetchAudioBlob(audioPath, opt = {}) {
    const url = this.opusUrl(audioPath);
    const token = this.getToken();
    const headers = new Headers();
    if (token) headers.set('Authorization', 'Bearer ' + token);

    return withRetries(async () => {
      const r = await fetch(url, { headers, mode: 'cors', redirect: 'follow', signal: opt.signal });
      if (r.status === 401) throw new Error('401: HuggingFace token required for audio');
      if (!r.ok) throw new Error(`Audio fetch failed (${r.status})`);
      return await r.blob();
    }, { retries: 2, signal: opt.signal });
  }
}

/* -------------------------------- Supabase -------------------------------- */

export class SupabaseData {
  /**
   * @param {{ url:string, anonKey:string }} cfg
   */
  constructor(cfg) {
    this.client = createClient(cfg.url, cfg.anonKey);
  }

  /* ------------------------------ Corrections ------------------------------ */

  /**
   * Load corrected JSON for a given audio path (if any).
   * @param {string} filePath
   * @returns {Promise<any|null>}
   */
  async getCorrection(filePath) {
    const { data, error } = await this.client
      .from('corrections')
      .select('json_data')
      .eq('file_path', filePath)
      .maybeSingle();
    if (error) {
      // allow "no rows" behavior (data=null) without throwing
      // supabase-js throws only for real errors
      throw error;
    }
    return data ? data.json_data : null;
  }

  /**
   * Upsert corrected JSON.
   * @param {string} filePath
   * @param {any} jsonObj
   * @returns {Promise<void>}
   */
  async upsertCorrection(filePath, jsonObj) {
    const { error } = await this.client
      .from('corrections')
      .upsert({ file_path: filePath, json_data: jsonObj }, { onConflict: 'file_path' });
    if (error) throw error;
  }

  /**
   * Load all corrections' file paths (for quick mark/green UI).
   * @returns {Promise<Set<string>>}
   */
  async loadAllCorrectionPaths() {
    const { data, error } = await this.client.from('corrections').select('file_path');
    if (error) throw error;
    return new Set((data || []).map(r => r.file_path));
  }

  /* -------------------------- Transcripts + marks -------------------------- */

  /**
   * Ensure 'transcripts' row exists, optionally with base_sha256 and text.
   * Handles both conflict keys used historically.
   * @param {string} filePath
   * @param {string} base_sha256
   * @param {string} [text]
   */
  async ensureTranscriptRow(filePath, base_sha256, text) {
    // First try simple onConflict by file_path
    let { error } = await this.client
      .from('transcripts')
      .upsert(
        { file_path: filePath, ...(text ? { text } : {}) },
        { onConflict: 'file_path' },
      );
    if (!error) return;

    // Fallback: dual-key upsert
    const row = { file_path: filePath, ...(base_sha256 ? { base_sha256 } : {}), ...(text ? { text } : {}) };
    const r2 = await this.client
      .from('transcripts')
      .upsert(row, { onConflict: 'file_path,base_sha256' });
    if (r2.error) throw r2.error;
  }

  /**
   * Fetch confirmation marks for file.
   * @param {string} filePath
   * @returns {Promise<Confirmation[]>}
   */
  async fetchConfirmations(filePath) {
    const { data, error } = await this.client
      .from('transcript_confirmations')
      .select('*')
      .eq('file_path', filePath)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  /**
   * Insert a single confirmation (prefix/exact/suffix anchors).
   * Auto-ensures transcript row if FK violation occurs.
   * @param {string} filePath
   * @param {{ base_sha256:string, start_offset?:number, end_offset?:number, prefix?:string, exact?:string, suffix?:string }} mark
   * @param {{textIfMissing?:string}} [opt]
   */
  async insertConfirmation(filePath, mark, opt = {}) {
    let { error } = await this.client
      .from('transcript_confirmations')
      .insert({ file_path: filePath, ...mark });

    if (error && error.code === '23503') { // foreign key
      await this.ensureTranscriptRow(filePath, mark.base_sha256, opt.textIfMissing);
      ({ error } = await this.client
        .from('transcript_confirmations')
        .insert({ file_path: filePath, ...mark }));
    }
    if (error) throw error;
  }

  /**
   * Batch insert confirmations. Ensures transcript row if needed.
   * @param {Array<object>} rows rows already containing file_path & base_sha256 & anchors
   * @param {{filePath:string, base_sha256:string, textIfMissing?:string}} ctx
   */
  async insertConfirmationsBatch(rows, ctx) {
    if (!rows?.length) return;
    let { error } = await this.client.from('transcript_confirmations').insert(rows);
    if (error && error.code === '23503') {
      await this.ensureTranscriptRow(ctx.filePath, ctx.base_sha256, ctx.textIfMissing);
      ({ error } = await this.client.from('transcript_confirmations').insert(rows));
    }
    if (error) throw error;
  }

  /**
   * Delete confirmations by id.
   * @param {number[]} ids
   */
  async deleteConfirmations(ids) {
    if (!ids?.length) return;
    const { error } = await this.client.from('transcript_confirmations').delete().in('id', ids);
    if (error) throw error;
  }
}

/* ----------------------------- Aggregated facade ---------------------------- */

/**
 * Convenience wrapper that wires both adapters.
 */
export class DataAPI {
  /**
   * @param {{ hf?: ConstructorParameters<typeof HuggingFaceClient>[0], supabase: ConstructorParameters<typeof SupabaseData>[0] }} cfg
   */
  constructor(cfg) {
    this.hf = new HuggingFaceClient(cfg.hf);
    this.db = new SupabaseData(cfg.supabase);
  }

  // HF tree helpers
  listFolders(opt) { return this.hf.listFolders(opt); }
  listOpusFiles(folder, opt) { return this.hf.listOpusFiles(folder, opt); }
  normPaths(folder, file) { return this.hf.normPaths(folder, file); }

  // Content fetching
  fetchTranscript(trPath, opt) { return this.hf.fetchTranscript(trPath, opt); }
  fetchAudioBlob(audioPath, opt) { return this.hf.fetchAudioBlob(audioPath, opt); }
  opusUrl(audioPath) { return this.hf.opusUrl(audioPath); } // useful when not needing auth blob

  // Corrections
  getCorrection(filePath) { return this.db.getCorrection(filePath); }
  upsertCorrection(filePath, jsonObj) { return this.db.upsertCorrection(filePath, jsonObj); }
  loadAllCorrectionPaths() { return this.db.loadAllCorrectionPaths(); }

  // Confirmations
  ensureTranscriptRow(filePath, base_sha256, text) { return this.db.ensureTranscriptRow(filePath, base_sha256, text); }
  fetchConfirmations(filePath) { return this.db.fetchConfirmations(filePath); }
  insertConfirmation(filePath, mark, opt) { return this.db.insertConfirmation(filePath, mark, opt); }
  insertConfirmationsBatch(rows, ctx) { return this.db.insertConfirmationsBatch(rows, ctx); }
  deleteConfirmations(ids) { return this.db.deleteConfirmations(ids); }
}

/* --------------------------------- Factory --------------------------------- */

/**
 * Create a DataAPI with your Supabase creds.
 * HuggingFace token is read via localStorage('hfToken') by default.
 */
export function createDataAPI({ supabaseUrl, supabaseAnonKey, hfDatasets, hfTokenGetter } = {}) {
  return new DataAPI({
    supabase: { url: supabaseUrl, anonKey: supabaseAnonKey },
    hf: { datasets: hfDatasets, tokenGetter: hfTokenGetter },
  });
}
