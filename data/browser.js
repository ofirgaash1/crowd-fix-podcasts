// v2/data/browser.js
// Folder/file browser and episode loader with race guards.

import { store } from '../core/state.js';
import { showToast } from '../ui/toast.js';
import { listFolders, listFiles, loadEpisode, hasCorrection, getConfirmations } from './api.js';

export function setupBrowser(els, { bumpEditGen } = {}) {
  if (!els?.folders || !els?.files) return;

  let currentFolder = null;
  let currentFile = null;
  let lastLoadController = null;
  let loadSeq = 0; // monotonic load sequence to ignore late results
  let desiredPath = null; // only allow loads for this path

  async function loadFolders() {
    try {
      els.folders.innerHTML = '<div class="item">טוען...</div>';
      const folders = await listFolders();
      if (!folders.length) { els.folders.innerHTML = '<div class="item">אין תיקיות</div>'; return; }
      els.folders.innerHTML = folders.map(f => `<div class="item" data-folder="${f.name}">📁 ${f.name}</div>`).join('');
      els.folders.querySelectorAll('.item').forEach(item => {
        item.addEventListener('click', () => {
          els.folders.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          loadFiles(item.dataset.folder);
        });
      });
      const firstFolder = els.folders.querySelector('.item');
      if (firstFolder) firstFolder.click();
    } catch (error) {
      console.error('Failed to load folders:', error);
      els.folders.innerHTML = '<div class="item error">שגיאה בטעינת תיקיות</div>';
    }
  }

  async function loadFiles(folderName) {
    if (!folderName) return;
    currentFolder = folderName;
    currentFile = null;
    try {
      els.files.innerHTML = '<div class="item">טוען...</div>';
      const files = await listFiles(folderName);
      if (!files.length) { els.files.innerHTML = '<div class="item">אין קבצים</div>'; return; }
      els.files.innerHTML = files.map(file => {
        const display = file.name.replace(/\.opus$/i, '');
        const hasCorr = hasCorrection(`${folderName}/${file.name}`);
        const correctionClass = hasCorr ? 'has-correction' : 'no-correction';
        return `<div class="item ${correctionClass}" data-file="${file.name}">🎵 ${display}</div>`;
      }).join('');
      els.files.querySelectorAll('.item').forEach(item => {
        item.addEventListener('click', () => {
          els.files.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          desiredPath = `${folderName}/${item.dataset.file}`;
          loadEpisodeFile(folderName, item.dataset.file);
        });
      });
    } catch (error) {
      console.error('Failed to load files:', error);
      els.files.innerHTML = '<div class="item error">שגיאה בטעינת קבצים</div>';
    }
  }

  async function loadEpisodeFile(folder, file) {
    if (!folder || !file) return;
    const myKey = `${folder}/${file}`;
    if (desiredPath && myKey !== desiredPath) return;
    currentFile = file;
    const mySeq = ++loadSeq;

    if (bumpEditGen) try { bumpEditGen(); } catch {}
    if (els.transcript && myKey === desiredPath) {
      els.transcript.dataset.folder = folder;
      els.transcript.dataset.file = file;
    }

    if (lastLoadController) lastLoadController.abort();
    const controller = new AbortController();
    lastLoadController = controller;

    try { showToast('טוען פרק...', 'info'); } catch {}
    const fileItem = els.files.querySelector(`[data-file="${file}"]`);
    if (fileItem) fileItem.classList.add('loading');

    try {
      const episode = await loadEpisode({ folder, file });
      if (controller.signal.aborted) return;
      if (mySeq !== loadSeq) return;
      if (desiredPath && myKey !== desiredPath) return;

      if (els.player) { els.player.src = episode.audioUrl; els.player.load(); }

      const initialText = (episode.initialTokens || []).map(t => t && t.word ? t.word : '').join('');
      store.setTokens(episode.initialTokens);
      store.setLiveText(initialText);
      store.setBaseline({ text: episode.baselineText, tokens: episode.baselineTokens });
      if (episode.version != null || episode.base_sha256) {
        store.setState({ version: episode.version || 0, base_sha256: episode.base_sha256 || '' }, 'version:init');
      } else {
        store.setState({ version: 0, base_sha256: '' }, 'version:clear');
      }
      try {
        if (episode.version != null) {
          const confs = await getConfirmations(`${folder}/${file}`, episode.version);
          const ranges = (confs || []).map(c => ({ id: c.id, range: c.range }));
          store.setConfirmedRanges(ranges);
        } else {
          store.setConfirmedRanges([]);
        }
      } catch (e) { console.warn('Failed to load confirmations:', e); store.setConfirmedRanges([]); }
    } catch (error) {
      console.error('Failed to load episode:', { error, myKey, mySeq });
      try { showToast(`שגיאה בטעינת פרק: ${error.message}`, 'error', 4000); } catch {}
    } finally {
      if (fileItem) fileItem.classList.remove('loading');
    }
  }

  // init
  loadFolders();
}

