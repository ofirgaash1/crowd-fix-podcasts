// v2/ui/settings-modal.js
// Settings modal for managing HF token (or other simple settings)

export function setupSettingsModal(els) {
  if (!els?.settingsBtn || !els?.modal || !els?.hfToken || !els?.mSave || !els?.mClear || !els?.mClose) return;

  function loadCurrentToken() {
    try { return localStorage.getItem('hfToken') || ''; } catch { return ''; }
  }
  function saveToken() {
    try { localStorage.setItem('hfToken', String(els.hfToken.value || '')); } catch {}
    updateSettingsButtonText();
  }
  function clearToken() {
    try { localStorage.removeItem('hfToken'); } catch {}
    els.hfToken.value = '';
    updateSettingsButtonText();
  }
  function updateSettingsButtonText() {
    try {
      const tok = loadCurrentToken();
      els.settingsBtn.textContent = tok ? '⚙️ יש לנו את זה' : '⚙️ צדיק, הזנת טוקן?';
    } catch {}
  }
  function openModal() {
    els.hfToken.value = loadCurrentToken();
    els.modal.classList.add('open');
    els.hfToken.focus();
  }
  function closeModal() {
    els.modal.classList.remove('open');
    els.settingsBtn.focus();
  }

  els.settingsBtn.addEventListener('click', openModal);
  els.mSave.addEventListener('click', () => { saveToken(); closeModal(); });
  els.mClear.addEventListener('click', clearToken);
  els.mClose.addEventListener('click', closeModal);

  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.modal.classList.contains('open')) closeModal(); });

  updateSettingsButtonText();
}

