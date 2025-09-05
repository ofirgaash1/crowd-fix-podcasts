// v2/render/diff-panel.js
// Minimal renderer for DMP-style diffs coming from diff-worker.

export function renderDiffHTML(container, diffs) {
  if (!container) return;
  if (!Array.isArray(diffs)) { container.textContent = ''; return; }

  // diffs: [ [op, text], ... ] where op: -1=delete, 0=equal, 1=insert
  const html = diffs.map(([op, data]) => {
    const safe = escapeHtml(data || '');
    if (op === 1)  return `<span class="diff-insert">${safe}</span>`;
    if (op === -1) return `<span class="diff-delete">${safe}</span>`;
    return `<span class="diff-equal">${safe}</span>`;
  }).join('');

  container.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
