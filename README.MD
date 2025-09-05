
# Explore + V2 Monorepo

This monorepo unifies two previously separate projects:

* **V2 Editor (frontend)** – a browser-based transcript editor with modeless editing, virtualized rendering, and alignment workers.
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
   * Background workers for diff and alignment (local WASM-based aligner, e.g. [echogarden](https://github.com/echogarden/echogarden)).

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
- Create a data root with the following layout (minimum is `json/`):
```
<data_root>/json/<folder>/<file_stem>/full_transcript.json.gz
# Optional for local playback
<data_root>/audio/<folder>/<file>.opus
```
- Flexibility/fallbacks added:
  - Transcripts are discovered recursively. Both of these work:
    - `<data_root>/json/<folder>/<stem>/full_transcript.json.gz`
    - `<data_root>/json/json/<folder>/<stem>/full_transcript.json.gz` (legacy nested)
  - The folder/file browser prefers local audio. If no local audio is found, it derives folder/file lists from the transcripts.
  - Episode responses prefer local `/audio/<folder>/<file>`; if missing, the backend returns a Hugging Face URL: `https://huggingface.co/datasets/ivrit-ai/audio-v2-opus/resolve/main/<folder>/<file>`.
  - Frontend can also fall back to Hugging Face listings if the backend has no local audio (add your HF token in the settings ⚙️ modal).

4) Run the backend (dev mode)
```bash
python explore/run.py --data-dir <data_root> --dev
```
- Verifications:
  - http://localhost:5000/folders
  - http://localhost:5000/files?folder=<folder>
  - http://localhost:5000/episode?folder=<folder>&file=<file>.opus

5) Open the frontend
- Easiest: open `v2/index.html` directly in your browser.
  - When opened via `file://`, the app uses `http://localhost:5000` automatically for API calls.
- Or serve statically and set in console: `window.EXPLORE_API_BASE = 'http://localhost:5000'`.

Notes
- The backend stores its SQLite database at `<data_root>/explore.sqlite`.
- In dev mode, authentication is bypassed via `TS_USER_EMAIL`; see `explore/run.py`.
- If you rely on Hugging Face fallbacks (folders/files/audio), add your HF token via the settings ⚙️ button. The backend now also emits HF audio URLs when local files are missing.

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

---

## Frontend (V2) Highlights

* **Virtualized transcript rendering** – renders in chunks for 60fps.
* **Workers** – `diff-worker.js` and `align-worker.js`.
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

### M4 – WASM Aligner

* Compile echogarden (or similar) to WebAssembly.
* Integrate into `align-worker.js`.

### M5 – Multi-user + Merge

* Conflict detection + 3-way merge.
* Store deltas as first-class citizens.

### M6 – Exports + Tooling

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
  - Open `v2/index.html` directly (file://)
  - Or serve statically and set `window.EXPLORE_API_BASE = 'http://localhost:5000'` in console

With `EXPLORE_API_BASE` set, the frontend prefers Explore endpoints; otherwise it falls back to Hugging Face and Supabase.

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

- WASM aligner integration (e.g., echogarden):
  - Local align step in worker to re-time words after edits
  - Confidence propagation and probability heatmap updates
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

## Alignment Roadmap

- Current align worker computes token timings from baseline anchors and new text (LCS + anchor windows).
- Next: plug in echogarden WASM for high‑quality alignment and confidence scores:
  - On save, align only edited segments (±1 neighbor) and write to `transcript_words`.
  - Use confidences for probability heatmap and confirmation hints.
