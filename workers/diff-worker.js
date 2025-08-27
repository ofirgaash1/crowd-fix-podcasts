// v2/render/overlay.js
// Super-light renderer for the right-side diff body (#diffBody)
export function mountDiffOverlay(rootEl) {
  if (!rootEl) {
    return { render() {} };
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function render(diffs) {
    if (!Array.isArray(diffs)) { rootEl.textContent = ''; return; }
    // Expecting dmp format: [ [op, text], ... ] where op ∈ {-1, 0, 1}
    rootEl.innerHTML = diffs.map(([op, seg]) => {
      if (op === 1)   return `<span class="diff-insert">${escapeHTML(seg)}</span>`;
      if (op === -1)  return `<span class="diff-delete">${escapeHTML(seg)}</span>`;
      return `<span class="diff-equal">${escapeHTML(seg)}</span>`;
    }).join('');
  }

  return { render };
}
