// v2/ui/hud.js
// Lightweight developer HUD showing render and worker timings.

export function setupHud(virtualizer, metricsRef = null) {
  const metrics = metricsRef || { diffMs: 0, alignMs: 0, renderMs: 0, tokens: 0, spans: 0 };

  function paint() {
    const el = document.getElementById('hud');
    if (!el || el.style.display === 'none') return;
    const vStats = virtualizer.getStats?.() || { renderMs: 0, tokens: 0, spans: 0 };
    metrics.renderMs = vStats.renderMs || 0;
    metrics.tokens = vStats.tokens || 0;
    metrics.spans = vStats.spans || 0;
    const lines = [
      `tokens: ${metrics.tokens}  spans: ${metrics.spans}`,
      `diff: ${metrics.diffMs?.toFixed?.(1)||0} ms  align: ${metrics.alignMs?.toFixed?.(1)||0} ms  render: ${metrics.renderMs?.toFixed?.(1)||0} ms`
    ];
    el.textContent = lines.join('\n');
  }

  const id = setInterval(paint, 500);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
      const el = document.getElementById('hud');
      if (!el) return;
      el.style.display = (el.style.display === 'none') ? 'block' : 'none';
      paint();
    }
  });

  return { metrics, destroy: () => clearInterval(id) };
}

