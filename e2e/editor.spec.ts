import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

async function waitForServer(url: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 401 || r.status === 404) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Backend did not start');
}

function writeGzJson(p: string, obj: any) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.from(JSON.stringify(obj), 'utf-8');
  const gz = zlib.gzipSync(buf);
  fs.writeFileSync(p, gz);
}

test.describe('Editor E2E', () => {
  let tmpDir: string;
  let proc: any;
  const folder = 'TestFolder';
  const file = 'episode.opus';

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-e2e-'));
    const tr = {
      segments: [
        { text: 'hello ', start: 0.0, end: 0.6, words: [ { word: 'hello', start: 0.0, end: 0.4 }, { word: ' ', start: 0.4, end: 0.6 } ] },
        { text: 'world', start: 0.6, end: 1.0, words: [ { word: 'world', start: 0.6, end: 1.0 } ] }
      ]
    };
    const p = path.join(tmpDir, 'json', folder, path.parse(file).name, 'full_transcript.json.gz');
    writeGzJson(p, tr);

    // Start backend in dev mode (bypass auth)
    proc = spawn('python', ['explore/run.py', '--data-dir', tmpDir, '--dev'], {
      env: { ...process.env, FLASK_ENV: 'development', TS_USER_EMAIL: 'tester@example.com' },
      stdio: 'inherit'
    });
    await waitForServer('http://localhost:5000/folders');
  });

  test.afterAll(async () => {
    try { proc?.kill(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('Load → Edit → Save → Version badge', async ({ page }) => {
    await page.goto('/v2');
    // Click folder and file
    await page.getByText(folder).click();
    await page.getByText(path.parse(file).name).click();
    // Wait transcript to populate
    const transcript = page.locator('#transcript');
    await expect(transcript).toContainText('hello ');
    // Edit: add exclamation
    await transcript.click();
    await page.keyboard.type('!');
    // Save
    await page.getByRole('button', { name: '⬆️ שמור תיקון' }).click();
    // Version badge shows גרסה 1
    const badge = page.locator('#versionBadge');
    await expect(badge).toContainText('גרסה');
  });

  test('409 conflict → merge modal → auto-merge', async ({ page, request }) => {
    await page.goto('/v2');
    // Open episode
    await page.getByText(folder).click();
    await page.getByText(path.parse(file).name).click();
    // First save → v1
    await page.locator('#transcript').click();
    await page.keyboard.type('!');
    await page.getByRole('button', { name: '⬆️ שמור תיקון' }).click();
    await expect(page.locator('#versionBadge')).toContainText('גרסה');

    // Create server v2 with non-overlapping edit via API
    const doc = `${folder}/${file}`;
    const latest = await (await fetch(`http://localhost:5000/transcripts/latest?doc=${encodeURIComponent(doc)}`)).json();
    const baseHash = latest.base_sha256 || '';
    const newText = latest.text + ' more';
    const resp = await fetch('http://localhost:5000/transcripts/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc, parentVersion: latest.version, expected_base_sha256: baseHash, text: newText, words: [{ word: newText }] })
    });
    if (!resp.ok) throw new Error('pre-save v2 failed');

    // Now client edit and save → should conflict
    await page.locator('#transcript').click();
    await page.keyboard.type('!');
    await page.getByRole('button', { name: '⬆️ שמור תיקון' }).click();
    // Merge modal visible
    await expect(page.locator('#mergeModal .modal-content')).toBeVisible();
    // Auto-merge
    await page.locator('#mergeTry').click();
    // After merge save, badge updates
    await expect(page.locator('#versionBadge')).toContainText('גרסה');
  });

  test('Confirmations select → save → reload', async ({ page }) => {
    await page.goto('/v2');
    await page.getByText(folder).click();
    await page.getByText(path.parse(file).name).click();
    // Save to ensure version exists
    await page.locator('#transcript').click();
    await page.getByRole('button', { name: '⬆️ שמור תיקון' }).click();
    // Select first word and confirm
    const transcript = page.locator('#transcript');
    await transcript.click();
    // Select characters by holding Shift+ArrowRight a few times
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.locator('#markReliable').click();
    // Expect toast and that button toggles
    await expect(page.locator('#markUnreliable')).toBeVisible();
  });
});

