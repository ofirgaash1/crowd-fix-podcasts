
# Explore + V2 Monorepo

This monorepo unifies two previously separate projects:

* **V2 Editor (frontend)** – a browser-based transcript editor with modeless editing and virtualized rendering.
* **Explore (backend)** – a Flask + SQLite service for managing transcripts, documents, and searchable indexes.

The goal: one cohesive tool for managing, editing, and aligning long-form transcripts at scale.

---

## Vision and Goals

1. **Word-level fidelity**

   * Store per-word timings (`start_time`, `end_time`) and probabilities.
   * Preserve this across edits, merges, and exports.

2. **Versioned transcripts (event sourcing)**

   * Each save = immutable transcript version.
   * Store deltas relative to both baseline and latest edit.
   * Hash gate validation: server rejects mismatched hashes.

3. **Robust editing pipeline**

   * Browser editor with smooth scrolling, karaoke highlighting, IME-safe editing, and probability-based highlights.
   * Diff runs in a web worker; alignment is handled on the backend via an endpoint.

4. **Explore DB as source of truth**

   * Replace HuggingFace + Supabase combo.
   * Explore DB stores documents, segments, words, versions, deltas, and confirmations.
   * API serves everything to the frontend.

5. **API-first architecture**

   * REST endpoints (later gRPC) for:

     * Listing folders/files
     * Loading episodes
     * Getting/saving transcript versions
     * Getting/saving confirmations
     * Exporting (VTT, CSV, JSON)
   * Backend enforces atomic saves and hash gates.

6. **Multi-user / merge support**

   * Conflict detection if hashes diverge.
   * Event log of edits for potential 3-way merge.

---

## Repo Structure

```
/v2/         → Transcript editor (JS/HTML/CSS)
/explore/    → Flask app (API + DB access)
/audio/      → Optional local audio files (see Data Layout)
/json/       → Transcripts (gz JSON); indexing scans recursively
/README.md   → This document
```

---

## How To Run

Quickstart for local development with the Explore backend and V2 frontend.

1) Prerequisites
- Python 3.10+ (with `pip`)
- Modern browser (Chrome/Edge/Firefox)

2) Install backend dependencies
```bash
# From repo root
python -m venv .venv
# Activate:
#  - macOS/Linux:   source .venv/bin/activate
#  - Windows (PS):  .venv\\Scripts\\Activate.ps1
pip install -r explore/requirements.txt
```

3) Prepare data directories
- Create a data root with the following layout (minimum is `json/`; audio is LOCAL‑ONLY):
```
<data_root>/json/<folder>/<file_stem>/full_transcript.json.gz
# Local audio playback (either layout works):
<data_root>/audio/<folder>/<file>.opus
# or content‑addressed layout (as in this repo):
<data_root>/audio/audio/<folder>/*/<folder>/<file>.opus
```
- Notes:
  - Transcripts are discovered recursively (also supports `json/json/...`).
  - Playback always uses local `/audio/<folder>/<file>`. No remote/HF fallback.

4) Run the backend (dev mode)
```bash
python explore/run.py --data-dir <data_root> --dev
```
- Verifications:
  - http://localhost:5000/folders
  - http://localhost:5000/files?folder=<folder>
  - http://localhost:5000/episode?folder=<folder>&file=<file>.opus

Examples
- On this repo, `<data_root>` is the repo root (where `audio/` and `json/` live). From repo root on Windows PowerShell:
  - `python explore/run.py --data-dir . --dev`
- Call the endpoints with URL-encoded parameters:
  - Folders: `http://localhost:5000/folders`
  - Files (Hebrew example): `http://localhost:5000/files?folder=%D7%90%D7%91%D7%95%D7%AA%20%D7%94%D7%90%D7%95%D7%9E%D7%94`
  - Episode (replace with a file from the files list):
    - `http://localhost:5000/episode?folder=%D7%90%D7%91%D7%95%D7%AA%20%D7%94%D7%90%D7%95%D7%9E%D7%94&file=2024.08.22%20%D7%A6%D7%A8%D7%99%D7%9A%20%D7%9C%D7%93%D7%A2%D7%AA%20%D7%9E%D7%9E%D7%99%20%D7%9C%D7%94%D7%AA%D7%92%D7%A8%D7%A9%2C%20%D7%98%D7%95%20%D7%91%D7%90%D7%91%20%D7%95%D7%97%D7%A0%D7%9F%20%D7%91%D7%9F%20%D7%90%D7%A8%D7%99%20%2313.opus`
    - Tip: use `encodeURIComponent(...)` in browser devtools or `[uri]::EscapeDataString(...)` in PowerShell to encode.

5) Open the frontend
- Easiest: open `v2/index.html` directly in your browser.
  - When opened via `file://`, the app uses `http://localhost:5000` automatically for API calls.
- Or serve statically and set in console: `window.EXPLORE_API_BASE = 'http://localhost:5000'`.
- Or, served by the backend: open `http://localhost:5000/v2`.

Dev helpers (Windows)
- Backend: `./dev.ps1 -DataDir . -Dev:$true` runs `python explore/run.py --data-dir . --dev`.
- Frontend: `open-v2.cmd` opens `v2/index.html`.

Docker
- Build: `docker build -t explore-app .`
- Run (mount data at `/data`):
  - `docker run --rm -p 5000:5000 -e DATA_DIR=/data -v %CD%:/data explore-app` (PowerShell)
  - `docker run --rm -p 5000:5000 -e DATA_DIR=/data -v $(pwd):/data explore-app` (bash)
- Open: `http://localhost:5000/v2`

CORS (when hosting frontend separately)
- The backend applies CORS centrally based on `ALLOWED_ORIGINS` (comma‑separated list).
- Example: `ALLOWED_ORIGINS="http://localhost:5000,https://your.frontend.domain"`
- Credentials are supported only for exact allowed origins. Prefer serving `/v2` from the same origin to avoid CORS.

Docker Compose (dev)
- One-time build: `docker compose build`
- Run with live reload + dev auth bypass: `docker compose up`
  - Serves on `http://localhost:5000/v2`
  - Mounts repo to `/app` (code) and `/data` (audio/json)

Notes
- The backend stores its SQLite database at `<data_root>/explore.sqlite`.
- In dev mode, authentication is bypassed via `TS_USER_EMAIL`; see `explore/run.py`.
- The frontend uses only the Explore backend. If local audio is missing, the backend may return a remote audio URL.

Auth & 401 handling
- All frontend requests to the Explore backend include credentials (cookies).
- If the server returns 401, the UI shows a toast “יש להתחבר” and redirects to `<EXPLORE_API_BASE>/login`.
- For cross‑origin hosting, make sure the backend sets:
  - `Access-Control-Allow-Credentials: true`
  - `Access-Control-Allow-Origin: <exact frontend origin>` (not `*`).

Authentication
- Dev bypass: set `FLASK_ENV=development` and `TS_USER_EMAIL=<you@example.com>` to skip Google login.
- Google OAuth (Authlib preferred):
  - Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
  - The app uses Google OpenID Connect to obtain user email and stores it in session.
  - Login: `/login` → `/authorize` → Google → `/login/authorized`.

Baseline and diff layers
- The “הצג שכבות שינויים” button shows every adjacent version pair.
- The baseline is injected as version `v0`, so after your first save you’ll see `v0 → v1`.
- Pairs with no changes are skipped from rendering.

Confirmations flow
- Confirming a selection requires the saved version hash to match.
- If you try to confirm and the hash doesn’t match (unsaved edits), the app auto‑saves, rechecks, and then persists the confirmation.

Frontend data sources
- The frontend now uses the Explore backend exclusively for folders/files/episodes and transcripts. No Hugging Face/Supabase fallbacks.

Troubleshooting
- 400 "missing ?folder=" or "missing ?file": ensure both are provided and URL-encoded.
- Files list is empty: if you don’t have local audio, it will be derived from the transcripts; make sure transcripts are under `json/...` (nested `json/json/...` is also supported).
- Audio won’t play locally: ensure the `.opus` exists under one of the supported layouts above.

---

## Current Database Schema

From `explore-index.db`:

```sql
CREATE TABLE documents (
  doc_id     INTEGER PRIMARY KEY,
  source     VARCHAR,
  episode    VARCHAR,
  full_text  TEXT
);

CREATE TABLE segments (
  doc_id        INTEGER,
  segment_id    INTEGER,
  segment_text  TEXT,
  avg_logprob   DOUBLE,
  char_offset   INTEGER,
  start_time    DOUBLE,
  end_time      DOUBLE,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id)
);
```

### Planned Extensions

* `words` table: `(doc_id, segment_id, word_id, word, start_time, end_time, probability)`
* `transcript_versions`: `(file_path, version, base_sha256, text, words JSONB, created_at)`
* `transcript_edits`: `(parent_version, child_version, patch, token_ops)`
* `transcript_confirmations`: `(file_path, version, base_sha256, start_offset, end_offset, prefix, exact, suffix)`

---

## API Overview

### Existing Explore Endpoints

* `/search/segment`
* `/search/segment/by_idx`
* `/export/segment/<source>/<filename>`
* `/audio/<path>`

### Planned Transcript Endpoints

Implemented:
- `GET /folders` — list audio folders
- `GET /files?folder=…` — list audio files in a folder
- `GET /episode?folder=…&file=…` — load baseline transcript JSON + audio URL
- `GET /transcripts/latest?doc=…` — latest version (text + words + base_sha256)
- `GET /transcripts/get?doc=…&version=N` — specific version
- `POST /transcripts/save` — `{ doc, parentVersion, expected_base_sha256, text, words }`
  - Atomic insert; hash‑gate against parent version (rejects mismatch)
  - Stores immutable version row + deltas relative to both v1 and parent
- `GET /transcripts/confirmations?doc=…&version=…` — list confirmations
- `POST /transcripts/confirmations/save` — `{ doc, version, base_sha256, items:[…] }`
  - Validates `base_sha256` matches stored version; clears + inserts items

New:
- `GET /transcripts/history?doc=…` — returns version lineage for UI history:
  - `[ { version, parent_version, hash, created_at }, ... ]`
  - Based on immutable `transcripts` and `transcript_edits`
- `POST /transcripts/migrate_words` — `{ doc, version? }` backfills `transcript_words` from stored JSON words or naive split
 - `GET /transcripts/words?doc=…&version=…[&segment=N][&count=K]` — normalized words with segment chunking; newline tokens preserved
 - `POST /transcripts/align_segment` — align a segment neighborhood server‑side; timing adjustments recorded in `transcript_edits.token_ops`

---

## Frontend (V2) Highlights

* **Virtualized transcript rendering** – renders in chunks for 60fps.
* **Worker** – `diff-worker.js` for computing diffs off the main thread (alignment handled by backend endpoint).
* **Player sync** – `sync.js` tracks audio time → active word.
* **Overlay renderer** – highlights probabilities, confirmations, and karaoke word.

---

## Milestones

### M1 – Merge

* Copy Explore backend into monorepo under `/backend/explore/`.
* Ensure it runs with `flask run`.

### M2 – Schema Upgrade

* Add `words`, `transcript_versions`, `transcript_edits`, `transcript_confirmations`.

### M3 – Frontend API Switch

* Replace Supabase/HF calls with Explore REST endpoints.
* Add config UI for Explore base URL.
* Implement pre-save hash gating.

### M5 – Exports + Tooling

* VTT, CSV, JSON exports from backend.
* Benchmarks and performance metrics.

---

## Example SQL Queries (SQLite Editor)

```sql
-- List tables
.tables

-- Check schema
.schema documents
.schema segments

-- Count rows
SELECT COUNT(*) FROM documents;
SELECT COUNT(*) FROM segments;

-- Inspect first document
SELECT * FROM documents LIMIT 1;

-- Inspect first 5 segments of doc_id=1
SELECT * FROM segments WHERE doc_id=1 ORDER BY segment_id LIMIT 5;
```

---

## Long-term Outlook

* Replace Flask REST with **gRPC service** for scale.
* Optional Postgres migration for larger datasets.
* Run alignment locally in-browser (WebAssembly) or remotely (Runpod).
* Support speaker diarization and segment boundary editing in the editor.
## Running Locally

- Data layout under a chosen `<data_root>`:
  - Audio: `<data_root>/audio/<folder>/<file>.opus`
  - Transcripts: `<data_root>/json/<folder>/<file_stem>/full_transcript.json.gz`
- Backend (Explore):
  - `python explore/run.py --data-dir <data_root> --dev`
  - Verify: `http://localhost:5000/folders`, `/files?folder=...`, `/episode?folder=...&file=...`
- Frontend (V2):
  - Open `v2/index.html` directly (file://), or
  - Serve statically and set `window.EXPLORE_API_BASE = 'http://localhost:5000'` in console, or
  - Open `http://localhost:5000/v2` (served by Explore)

The frontend now uses only the Explore backend (no Hugging Face token or Supabase fallback).

HUD & Performance
- Toggle HUD with Ctrl+Alt+D to see visible token count and render time.
- Stress test the virtualizer from console: `__loadWorstCase(200000)`.

## Data Model

- Documents index (SQLite): `documents`, `segments` (existing)
- Versioned transcripts (SQLite):
  - `transcripts(file_path, version, base_sha256, text, words JSON, created_at)`
  - `transcript_edits(file_path, parent_version, child_version, dmp_patch, token_ops, created_at)`
    - Stores deltas relative to both v1 and parent, for fast replay and audits
  - `transcript_confirmations(file_path, version, base_sha256, start_offset, end_offset, prefix, exact, suffix, created_at)`
- Words storage (scaffolded now):
  - `transcript_words(file_path, version, segment_index, word_index, word, start_time, end_time, probability)` with indexes
    - Partial reads: `GET /transcripts/words?doc=…&version=…&segment=N[&count=K]`
  - Populated on save from JSON `words[]` (newline tokens advance `segment_index`)
  - Migration endpoint coming next; backfill can be done offline or via admin CLI

Hash Gate Semantics
- `POST /transcripts/save` validates:
  - `parentVersion` equals current latest version (if exists)
  - `expected_base_sha256` equals the stored hash of the parent’s text
  - On success, new row’s `base_sha256 = sha256(new_text)` is returned and used by the frontend
- `POST /transcripts/confirmations/save` validates `base_sha256` matches the stored hash for that version

## Roadmap
- 3‑way merge & multi‑user support:
  - Event log for each save, DAG of versions
  - Conflict detection (hash + ancestor tracking), merge UI
- Speaker diarization integration:
  - Store speaker turns; render with coloring and quick navigation
  - Words table migration:
  - Migrate from JSON words to normalized per‑word table with indexes

---

## Conflict Flow

- Save path performs an optimistic `POST /transcripts/save` with `parentVersion` and `expected_base_sha256`.
- On success → backend returns `{ version, base_sha256 }` and the editor updates state.
- On conflict (HTTP 409): backend returns a JSON payload with:
  - `latest`, `parent`, `diff_parent_to_latest`, `diff_parent_to_client`.
  - UI opens a merge dialog:
    - Attempts auto‑merge when edits are non‑overlapping (client + latest applied to base).
    - If overlapping, keeps the dialog open for manual resolution (pick Latest or Mine; fine‑grained merge coming next).

## Partial Words API and Virtualizer

- `GET /transcripts/words?doc=…&version=…&segment=N[&count=K]` returns tokens for segments N..N+K‑1.
- The frontend progressively loads words in chunks (e.g., 50 segments) to reduce initial load, feeding the virtualizer as data arrives.
- Future: window‑aware fetching (±500 tokens) and eviction.

## Alignment

- Alignment is handled server-side via the `/transcripts/align_segment` endpoint, which re-times words within a small neighborhood of the edited segment and records timing adjustments in `transcript_edits.token_ops`.

## CLI

- Reindex: rebuild the documents/segments index
  - `python -m explore.app.cli reindex --data-dir <data_root> [--db <sqlite_path>]`
  - Scans for `full_transcript.json.gz` and writes SQLite index (default `<data_root>/explore-index.db`).

- Stats: show index counts and sample rows
  - `python -m explore.app.cli stats --db <sqlite_path>`
  - Prints documents/segments counts, first document metadata, and first segments.

## Testing & CI

- Tests: `pip install -r explore/requirements.txt -r requirements-dev.txt && pytest -q`
- CI: GitHub Actions workflow `.github/workflows/ci.yml` runs tests on Python 3.10/3.11 for push/PR.

E2E (Playwright)
- Install Node deps: `npm install` (then one-time: `npm run e2e:install`)
- Run backend + tests automatically: `npm run e2e`
  - Tests will create a temp dataset under OS temp, spawn `python explore/run.py --dev`, and drive `http://localhost:5000/v2`.
  - Scenarios covered:
    - Load episode → edit → save → version badge
    - Trigger 409 → merge modal → auto‑merge
    - Confirmations: select → save → reload






























# Crowd‑Fix Podcasts — One‑Shot Tutorial Transcript (Full Project Walkthrough)

> **Style & pacing:** Tutorial/showcase for beginners. I’ll narrate every step and show the code and the UI. When you see **On screen**, perform exactly that action; when you see **Voiceover**, read the line. The app UI is right‑to‑left (RTL), but everything works the same in LTR.

---

## Title Card (5s)
**On screen:** “Crowd‑Fix Podcasts — Build, Edit, Version, Diff, Confirm, Export, Search, Align.”

**Voiceover:** Welcome! In this one video, we’ll install the project, run it locally, tour the UI, and then go deeper: edits, version history, conflicts and merges, confirmations, exports, search, and alignment. We’ll also peek under the hood so you know exactly how things work.

---

## 1) What we’re building (30–45s)
**Voiceover:** This repo is a **monorepo** with a frontend transcript editor and a Flask backend. The editor can render *very long* transcripts smoothly, supports right‑to‑left languages, shows version history and diffs, and lets you confirm reliable text spans. The backend serves folders/files/episodes, stores **versioned** transcripts with **hash‑gated** saves, exports to VTT/CSV/JSON, and provides alignment.

**On screen:** Open the repo root. Briefly show these paths:
- `v2/index.html` — static shell (RTL‑friendly layout)
- `v2/main.js` — wires the app
- `v2/render/virtualizer.js`, `v2/render/overlay.js` — fast, windowed rendering
- `v2/workers/diff-worker.js`, `v2/workers/diff-core.js` — off‑main‑thread diffs
- `v2/ui/*.js` — UI controls, merge modal, theme
- `explore/app/routes/*.py` — Flask routes: browser, transcripts, export, auth
- `explore/app/services/*.py` — DB, indexing, search helpers

**Voiceover:** Pro tip: To learn any feature, first look for its API in `explore/app/routes`, then see how it’s called from `v2/main.js` and `v2/data/*`.

---

## 2) Run it locally (2–3 min)
**Voiceover:** Let’s run the backend in dev mode and point it at your data. Dev mode bypasses login so you can explore quickly.

### Windows (PowerShell)
**On screen:**
```powershell
.venv\Scripts\Activate.ps1
pip install -r explore/requirements.txt
./dev.ps1              # defaults: DataDir='.' ; Dev = $true
# Optional: ./dev.ps1 -DataDir C:\data
# Optional: ./dev.ps1 --% --no-dev
```

### macOS/Linux (bash)
**On screen:**
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r explore/requirements.txt
chmod +x dev.sh
./dev.sh               # defaults: DATA_DIR='.' ; dev mode on
# Optional: ./dev.sh -d /path/to/data
# Optional: ./dev.sh --no-dev
```

**Voiceover:** The **data root** is where the backend looks for `audio/` and `json/` folders if you have them.

---

## 3) Open the editor (30s)
**On screen:** Open `v2/index.html` directly (file:// URL).

**Voiceover:** When opened from file, the editor points to `http://localhost:5000` automatically. You can also visit `http://localhost:5000/v2` to serve the static files from the backend.

**On screen:** Call out the RTL layout: **browser** (folders/files) on the **right**, **editor** in the **middle**, **diff/history** on the **left**.

---

## 4) Key concepts (1–2 min)
**Voiceover:** Four ideas make the app feel fast and reliable:

- **Tokens & segments:** Text is a sequence of tokens. Most tokens are words with optional timing; a special token `"\n"` marks a **segment break**. Segments matter for exports and alignment.
- **Virtualized rendering:** We render only what’s visible plus a small buffer. Even very long transcripts scroll smoothly.
- **Baseline text:** When you load an episode, we store that snapshot as the **baseline** for comparison.
- **HUD:** Press **Ctrl+Alt+D** to toggle a developer overlay showing visible tokens and last render time.

**On screen:** Toggle the HUD and point to its numbers.

---

## 5) Load an episode (30–45s)
**On screen:** In the right panel, click a folder, then a file.

**Voiceover:** The editor calls **`/episode`**, which returns transcript JSON and an audio URL served via `/audio`. The middle panel displays tokens; newline tokens separate segments.

---

## 6) First edit & save (3–4 min)
**Voiceover:** Let’s make a tiny edit and talk about **versioned, hash‑gated saves**.

**On screen:** Click in the transcript and add an exclamation mark `!`. Then click **“⬆️ שמור תיקון”**.

**Voiceover:** The editor sends a POST to **`/transcripts/save`** with:
- `doc`: `"<folder>/<file.opus>"`
- `parentVersion`: the version you’re editing from
- `expected_base_sha256`: the SHA‑256 of the **parent text**
- `text` and `words`: your current full text and token list

**On screen (DevTools → Console):** Show an **exact fetch** for a first‑ever save:
```js
fetch('http://localhost:5000/transcripts/save', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
  body: JSON.stringify({
    doc: 'Folder/Name.opus',
    parentVersion: null,                // brand-new document
    expected_base_sha256: '',           // no parent hash yet
    text: '...your full text...',
    words: [ { word: 'hello' }, { word: ' ' }, { word: '\n' }, { word: 'world' } ]
  })
}).then(r => r.json()).then(console.log)
```

**Voiceover:** On the first save, the server creates **version 1** and computes its hash. You’ll see the version badge update with the new version and short hash.

### Why hashes?
**Voiceover:** Hashes prevent silent overwrites. Before saving, the frontend computes the **parent’s** hash and sends it as `expected_base_sha256`. The backend compares it to the stored hash. If they differ, we decline the save with **HTTP 409** — that’s a **conflict**.

---

## 7) Conflicts & merges (5–6 min)
**Voiceover:** We’ll simulate a real conflict, read the 409 payload, and resolve it.

**On screen (Console):** Create a server‑side save to move the latest forward, then try saving from a stale parent.
```js
(async () => {
  const doc = 'Folder/Name.opus';
  // Get the current latest (becomes our stale parent)
  const latestBefore = await (await fetch(`http://localhost:5000/transcripts/latest?doc=${encodeURIComponent(doc)}`, { credentials:'include' })).json();

  // Someone else saves a new version
  const fresher = await (await fetch(`http://localhost:5000/transcripts/latest?doc=${encodeURIComponent(doc)}`, { credentials:'include' })).json();
  const serverEdit = (fresher.text || '') + ' [server edit]';
  await fetch('http://localhost:5000/transcripts/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({
      doc,
      parentVersion: fresher.version,
      expected_base_sha256: fresher.base_sha256,
      text: serverEdit,
      words: [{ word: serverEdit }]
    })
  });

  // Now try to save from the stale parent (should 409)
  const myText = (latestBefore.text || '') + ' [my local edit]';
  const resp = await fetch('http://localhost:5000/transcripts/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({
      doc,
      parentVersion: latestBefore.version,
      expected_base_sha256: latestBefore.base_sha256,
      text: myText,
      words: [{ word: myText }]
    })
  });
  console.log('status', resp.status);
  console.log('payload', await resp.json().catch(()=>({})));
})();
```

**Voiceover:** The backend returns **409** with:
- `reason`: `"version_conflict"` or `"hash_conflict"`
- `latest`: { version, base_sha256, text }
- `parent`: { version, base_sha256, text } — the base you edited from
- `diff_parent_to_latest` and `diff_parent_to_client`: unified diffs for the merge UI

**On screen:** In the app, the **merge modal** offers:
- **Reload latest** — discard local edits and load the newest
- **Auto‑merge (beta)** — if edits don’t overlap, merge and save
- **Close** — deal with it later

**Voiceover (under the hood):** We diff **base→latest** and **base→client**. If the changed ranges don’t overlap, we apply both edits to the base (right‑to‑left to keep offsets stable), then save against the *true* latest parent.

---

## 8) History & diff layers (3–4 min)
**Voiceover:** Every save becomes an **immutable version** with an incrementing number and a `base_sha256`. You can explore versions and visualize change.

**On screen:** Open the **History** tab (left). Click a version to see a **diff vs. current**.

**On screen (Console):** Fetch history via API:
```js
(async () => {
  const doc = 'Folder/Name.opus';
  const hist = await (await fetch(`http://localhost:5000/transcripts/history?doc=${encodeURIComponent(doc)}`, { credentials: 'include' })).json();
  console.log(hist);
})();
```

**Voiceover:** The **Diff** tab’s **Show Layers** button builds a staircase of **adjacent diffs** (vN→vN+1). Empty diffs are skipped so you can scan real changes quickly. Diffs are computed in a **web worker** and rendered efficiently for long text and RTL.

---

## 9) Confirmations (2–3 min)
**Voiceover:** **Confirmations** mark reliable spans of text **anchored** to a specific version + hash. If you have unsaved edits, the editor saves first to get a stable anchor.

**On screen:** Select a range and click **“✅ אשר קטע מסומן”**.

**Voiceover:** The frontend POSTs to **`/transcripts/confirmations/save`**:
- `doc`, `version`, `base_sha256`
- `items`: list of `{ start_offset, end_offset, prefix, exact, suffix }`

**On screen (Console):**
```js
fetch('http://localhost:5000/transcripts/confirmations/save', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
  body: JSON.stringify({
    doc: 'Folder/Name.opus',
    version: 2,
    base_sha256: '...hash...',
    items: [ { start_offset: 10, end_offset: 25, prefix: '...', exact: 'your text', suffix: '...' } ]
  })
}).then(r => r.json()).then(console.log)
```

**Voiceover:** Confirmed ranges are stored transactionally and reloaded so the highlights match the backend. Offsets are absolute over the full text, and `"\n"` counts as a single character. Be mindful of invisible Unicode like ZWJ; we normalize common cases.

---

## 10) Exports for QA & sharing (2–3 min)
**Voiceover:** Export any version to **WebVTT**, **CSV**, or **JSON**. Pinning to a version guarantees reproducibility.

**On screen:**
- VTT: `GET /export/transcript/vtt?doc=<folder>/<file.opus>&version=N`
- CSV: `GET /export/transcript/csv?doc=<...>&version=N`
- JSON: `GET /export/transcript/json?doc=<...>&version=N`

**Voiceover:** WebVTT works in players; CSV is great for spreadsheet reviews; JSON is best for scripts. Segment boundaries come from newline tokens.

---

## 11) Search & local index (3–4 min)
**Voiceover:** The backend can index transcripts from `json/` into a local SQLite DB for fast search.

**On screen (CLI):**
```bash
# Build the index (creates explore-index.db in your data root)
python -m explore.app.cli reindex --data-dir .

# Quick stats
python -m explore.app.cli stats --db explore-index.db
```

**On screen (Console → JSON API):**
```js
(async () => {
  const q = 'שלום';          // any term
  const page = 1;             // 1-based
  const r = await fetch(`http://localhost:5000/search?q=${encodeURIComponent(q)}&page=${page}`, {
    headers: { 'Accept': 'application/json' }, credentials: 'include'
  });
  const { results, pagination } = await r.json();
  console.log(pagination);
  console.table(results);
})();
```

**Voiceover:** Each hit includes `char_offset` and segment timing so the UI can jump to the right spot. Under the hood, we map offsets to segments using precomputed boundaries.

---

## 12) Alignment (3–4 min)
**Voiceover:** After edits, word timings may drift. The backend’s **alignment** endpoint re‑computes timings around a segment using your **audio** as ground truth.

**On screen:** Place audio at `audio/<folder>/<file>.opus` under your data root.

**On screen (Console):**
```js
(async () => {
  const doc = 'Folder/Name.opus';
  const latest = await (await fetch(`http://localhost:5000/transcripts/latest?doc=${encodeURIComponent(doc)}`, { credentials:'include' })).json();
  const version = latest.version;
  const segment = 0;       // try 0, 1, ...
  const neighbors = 1;     // clamped 0..3
  const res = await fetch('http://localhost:5000/transcripts/align_segment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ doc, version, segment, neighbors })
  });
  console.log('status', res.status);
  console.log('json', await res.json().catch(()=>({})));
})();
```

**Voiceover:** Success returns `{ ok: true, changed_count, total_compared }`. If audio is missing you’ll see **404**; if words lack timings, you’ll see `no-words` or `no-timings`. Adjust and try again.

**Voiceover (auditing):** Timing adjustments are recorded in the **edits log** as `token_ops` with `type: "timing_adjust"`. Fetch via `GET /transcripts/edits?doc=...` to inspect what changed.

---

## 13) Under the hood (quick pointers) (1–2 min)
**Voiceover:** Code breadcrumbs for future exploration:

- **Saves & conflicts:** `explore/app/routes/transcripts.py` (`/transcripts/save`, 409 payload)
- **History:** same file (`/transcripts/history`)
- **Exports:** `explore/app/routes/export.py`
- **Index/search:** `explore/app/services/index.py`, `explore/app/services/search.py`, route in `routes/main.py`
- **Diffs:** `v2/workers/diff-core.js` (deterministic core), `v2/workers/diff-worker.js`
- **Virtualizer & overlay:** `v2/render/virtualizer.js`, `v2/render/overlay.js`
- **UI wiring & merge modal:** `v2/main.js`, `v2/ui/controls.js`, `v2/ui/merge-modal.js`

---

## 14) Troubleshooting & pro tips (1–2 min)
**Voiceover:**
- **“hash_conflict” on save:** Another save happened or your expected hash was computed from the wrong text. Reload latest or use the merge dialog.
- **Newline discipline:** Inserting/deleting `"\n"` changes **segments** — allowed, but impacts alignment and exports.
- **Unicode quirks:** Zero‑width marks can surprise diffs and offsets. The app normalizes common cases; still, prefer clean text sources.
- **Performance:** Toggle HUD to monitor render time. The renderer is windowed; diffs run off‑thread.
- **Search looks off by one:** Check for leading/trailing spaces when composing segments in your source JSON.
- **Alignment failures:** Ensure audio exists at `audio/<folder>/<file>.opus` and there are timings in the chosen window; widen `neighbors` if needed.

---

## 15) Wrap‑up (15–20s)
**Voiceover:** You’ve seen the full loop: run locally, edit and save safely, resolve conflicts, audit history and diffs, mark confirmed spans, export cleanly, search fast, and realign timings. You also know where everything lives in the code. Have ideas for branching histories or richer merge UI? This foundation is ready for it.

---

## Appendix — Copy/paste cheatsheet

### Run (Windows)
```powershell
.venv\Scripts\Activate.ps1
pip install -r explore/requirements.txt
./dev.ps1
# Open v2/index.html or http://localhost:5000/v2
```

### Run (bash)
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r explore/requirements.txt
chmod +x dev.sh && ./dev.sh
# Open v2/index.html or http://localhost:5000/v2
```

### Saves (first & normal)
```js
// First save (no parent)
fetch('/transcripts/save', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
  body: JSON.stringify({ doc:'Folder/Name.opus', parentVersion:null, expected_base_sha256:'', text:'...', words:[{word:'...'}] })
});

// Normal save
const latest = await (await fetch(`/transcripts/latest?doc=${encodeURIComponent('Folder/Name.opus')}`, {credentials:'include'})).json();
fetch('/transcripts/save', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
  body: JSON.stringify({ doc:'Folder/Name.opus', parentVersion:latest.version, expected_base_sha256:latest.base_sha256, text:latest.text+'!', words:[{word:latest.text+'!'}] })
});
```

### Conflict demo
```js
// Stale save to trigger 409 (see full snippet in section 7)
```

### History & layers
```js
fetch(`/transcripts/history?doc=${encodeURIComponent('Folder/Name.opus')}`, {credentials:'include'}).then(r=>r.json());
```

### Confirmations
```js
fetch('/transcripts/confirmations/save', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
  body: JSON.stringify({ doc:'Folder/Name.opus', version:2, base_sha256:'...', items:[{ start_offset:10, end_offset:25, prefix:'...', exact:'...', suffix:'...' }] })
});
```

### Exports
```text
/export/transcript/vtt?doc=<folder>/<file.opus>&version=N
/export/transcript/csv?doc=<folder>/<file.opus>&version=N
/export/transcript/json?doc=<folder>/<file.opus>&version=N
```

### Search & index
```bash
python -m explore.app.cli reindex --data-dir .
python -m explore.app.cli stats --db explore-index.db
```

```js
fetch(`/search?q=${encodeURIComponent('שלום')}&page=1`, { headers:{'Accept':'application/json'}, credentials:'include' });
```

### Alignment
```js
fetch('/transcripts/align_segment', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
  body: JSON.stringify({ doc:'Folder/Name.opus', version:1, segment:0, neighbors:1 })
});
```
