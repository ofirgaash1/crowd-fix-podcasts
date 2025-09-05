// v2/ui/merge-modal.js
// Minimal conflict dialog: shows diffs, allows reload-latest or attempt auto-merge

export function setupMergeModal(els) {
  if (!els?.mergeModal || !els?.mergeReload || !els?.mergeTry || !els?.mergeClose || !els?.diffParentLatest || !els?.diffParentClient) return {
    open: () => {}, close: () => {}
  };
  function open() { els.mergeModal.classList.add('open'); }
  function close() { els.mergeModal.classList.remove('open'); }
  els.mergeClose.addEventListener('click', close);
  els.mergeModal.addEventListener('click', (e) => { if (e.target === els.mergeModal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.mergeModal.classList.contains('open')) close(); });
  return { open, close };
}

export function renderConflict(els, payload) {
  if (!els?.diffParentLatest || !els?.diffParentClient) return;
  const p2l = payload?.diff_parent_to_latest || '';
  const p2c = payload?.diff_parent_to_client || '';
  els.diffParentLatest.textContent = String(p2l || '');
  els.diffParentClient.textContent = String(p2c || '');
}

