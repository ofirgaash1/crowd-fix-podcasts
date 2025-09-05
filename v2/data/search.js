// v2/data/search.js
// Lightweight helper to call backend search JSON API

const JSON_ACCEPT = { Accept: 'application/json' };

export async function search({ q, page = 1, perPage = 100 } = {}) {
  if (!q) return { results: [], pagination: { page: 1, per_page: perPage, total_pages: 0, total_results: 0 } };
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('page', String(page));
  params.set('max_results_per_page', String(perPage));
  const url = `/search?${params.toString()}`;
  const r = await fetch(url, { headers: JSON_ACCEPT, credentials: 'include' }).catch(() => null);
  if (!r || !r.ok) throw new Error('search failed');
  const j = await r.json();
  const results = Array.isArray(j?.results) ? j.results : [];
  const pagination = j?.pagination || { page, per_page: perPage, total_pages: 0, total_results: results.length };
  return { results, pagination };
}

/**
 * Batch fetch segment details (text + timing) for results
 * Input: [{ episode_idx, char_offset }]
 * Returns array of { episode_idx, char_offset, segment_index, start_sec, end_sec, text }
 */
export async function fetchSegments(lookups = []) {
  if (!Array.isArray(lookups) || !lookups.length) return [];
  const r = await fetch('/search/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ lookups })
  }).catch(() => null);
  if (!r || !r.ok) return [];
  return await r.json();
}

export function resultToEpisode(result) {
  // Expect source like "folder/stem" → map to folder, file.opus
  const src = String(result?.source || '');
  const parts = src.split('/');
  if (parts.length >= 2) {
    const folder = parts[0];
    const file = parts.slice(1).join('/') + '.opus';
    return { folder, file };
  }
  return null;
}

export default { search, fetchSegments, resultToEpisode };
