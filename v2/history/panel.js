// v2/history/panel.js
// Minimal history sidebar: lists versions and previews diffs against current

import { api } from '../data/api.js';
import { getState } from '../core/state.js';

function el(id) { return document.getElementById(id); }

function renderList(container, items, onClick) {
  container.innerHTML = '';
  if (!Array.isArray(items) || !items.length) {
    container.innerHTML = '<div class="item">אין גרסאות</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'item';
    const ts = it.created_at ? new Date(it.created_at).toLocaleString() : '';
    const v = it.version;
    div.textContent = `v${v} • ${ts}`;
    div.dataset.version = String(v);
    div.addEventListener('click', () => onClick(v));
    frag.appendChild(div);
  }
  container.appendChild(frag);
}

function renderDiffInto(target, diffs) {
  if (!target) return;
  const frag = document.createDocumentFragment();
  for (const [op, s] of (diffs || [])) {
    const span = document.createElement('span');
    span.textContent = String(s || '');
    if (op === -1) span.style.background = 'rgba(244,67,54,0.18)';
    if (op === 1) span.style.background = 'rgba(76,175,80,0.18)';
    frag.appendChild(span);
  }
  target.innerHTML = '';
  target.appendChild(frag);
}

export function setupHistoryPanel(els, workers) {
  const listEl = el('historyList');
  if (!listEl) return;

  async function refresh() {
    const folder = els.transcript?.dataset.folder || '';
    const file = els.transcript?.dataset.file || '';
    if (!folder || !file) { listEl.innerHTML = ''; return; }
    const doc = `${folder}/${file}`;
    try {
      const items = await api.getTranscriptHistory(doc);
      renderList(listEl, items, async (version) => {
        try {
          const v = await api.getTranscriptVersion(doc, version);
          const current = getState()?.liveText || '';
          const base = v?.text || '';
          const res = await workers.diff.send(base, current, { editCost: 7, timeoutSec: 0.8 });
          const diffs = Array.isArray(res?.diffs) ? res.diffs : [];
          const target = els.diffBody;
          renderDiffInto(target, diffs);
        } catch (e) { console.warn('history diff failed', e); }
      });
    } catch (e) {
      console.warn('history fetch failed', e);
      listEl.innerHTML = '<div class="item error">שגיאה בטעינת היסטוריה</div>';
    }
  }

  // initial load + on version change
  setTimeout(refresh, 0);
  try {
    // naive: refresh on version change or when a new doc loads
    els.transcript?.addEventListener('v2:doc-change', refresh);
  } catch {}
  return { refresh };
}

