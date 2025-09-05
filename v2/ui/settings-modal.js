// v2/ui/settings-modal.js
// Settings modal for managing HF token (or other simple settings)

export function setupSettingsModal(els) {
  if (!els?.settingsBtn || !els?.modal || !els?.mClose) return;

  function openModal() { try { els.modal.classList.add('open'); } catch {} }
  function closeModal() { try { els.modal.classList.remove('open'); els.settingsBtn?.focus(); } catch {} }

  try { els.settingsBtn.addEventListener('click', openModal); } catch {}
  try { els.mClose.addEventListener('click', closeModal); } catch {}
  try { els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); }); } catch {}
  try { document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.modal.classList.contains('open')) closeModal(); }); } catch {}
}

