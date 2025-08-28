// v2/ui/theme.js
export function setupThemeToggle(els) {
  if (!els.themeToggle || !els.themeIcon) return;

  function getCurrentTheme() {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  }
  function saveTheme(theme) {
    try { localStorage.setItem('theme', theme); } catch {}
  }
  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'dark') {
      html.classList.add('theme-dark');
      html.classList.remove('theme-light');
    } else {
      html.classList.add('theme-light');
      html.classList.remove('theme-dark');
    }
  }
  function updateThemeIcon(theme) {
    els.themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  function toggleTheme() {
    const cur = getCurrentTheme();
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next); saveTheme(next); updateThemeIcon(next);
  }
  function initializeTheme() {
    const saved = getCurrentTheme();
    applyTheme(saved); updateThemeIcon(saved);
  }

  els.themeToggle.addEventListener('click', toggleTheme);
  initializeTheme();
}

