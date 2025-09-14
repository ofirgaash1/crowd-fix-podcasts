import sys
import os
from pathlib import Path
import click

from .utils import get_transcripts
from .services.index import IndexManager
from .services.db import DatabaseService


@click.group()
def cli():
    """Explore admin/maintenance commands."""
    pass


@cli.command('reindex')
@click.option('--data-dir', type=click.Path(path_type=Path, exists=True), required=True,
              help='Data root containing json/ and optionally audio/.')
@click.option('--db', 'db_path', type=click.Path(path_type=Path), default=None,
              help='Path to the index SQLite file (default: <data-dir>/explore-index.db).')
def reindex_cmd(data_dir: Path, db_path: Path | None):
    """Rebuild the search index (documents + segments) from transcript JSONs.

    Scans recursively for full_transcript.json.gz and writes an idempotent
    SQLite index with tables: documents, segments.
    """
    data_dir = data_dir.resolve()
    if db_path is None:
        db_path = data_dir / 'explore-index.db'
    else:
        db_path = Path(db_path).resolve()

    json_root = data_dir / 'json'
    scan_root = json_root if json_root.exists() else data_dir
    click.echo(f'Scanning transcripts under: {scan_root}')
    recs = get_transcripts(scan_root)
    if not recs:
        click.echo('No transcripts found (looking for */full_transcript.json.gz).', err=True)
        sys.exit(1)

    # Ensure parent dir exists
    db_path.parent.mkdir(parents=True, exist_ok=True)
    click.echo(f'Building index: {db_path}')

    # Build index into the target SQLite file
    mgr = IndexManager(file_records=recs, path=str(db_path))
    idx = mgr.get()
    docs, chars = idx.get_document_stats()
    click.echo(f'Indexed {docs} documents, total {chars or 0} chars')
    click.echo('Done.')


if __name__ == '__main__':
    cli()

@cli.command('stats')
@click.option('--db', 'db_path', type=click.Path(path_type=Path, exists=True), required=True,
              help='Path to the index SQLite file (e.g., <data_root>/explore-index.db).')
def stats_cmd(db_path: Path):
    """Print basic index stats and sample rows from documents/segments."""
    db_path = Path(db_path).resolve()
    click.echo(f'Opening index: {db_path}')

    db = DatabaseService(path=str(db_path))

    # Counts
    cur = db.execute("SELECT COUNT(*) FROM documents")
    doc_count = cur.fetchone()[0]
    cur = db.execute("SELECT COUNT(*) FROM segments")
    seg_count = cur.fetchone()[0]
    click.echo(f'Documents: {doc_count:,}')
    click.echo(f'Segments:  {seg_count:,}')

    # Sample document
    cur = db.execute("SELECT doc_id, source, episode, LENGTH(full_text) FROM documents ORDER BY doc_id ASC LIMIT 1")
    row = cur.fetchone()
    if row:
        doc_id, source, episode, length = row
        click.echo('\nFirst document:')
        click.echo(f'  doc_id={doc_id}  source="{source}"  episode="{episode}"  full_text_len={length}')
        # Sample segments for this doc
        click.echo('  First segments:')
        cur = db.execute(
            "SELECT segment_id, LENGTH(segment_text), avg_logprob, char_offset, start_time, end_time "
            "FROM segments WHERE doc_id=? ORDER BY segment_id ASC LIMIT 5",
            [doc_id]
        )
        rows = cur.fetchall() or []
        for (seg_id, seg_len, avg_lp, ch_off, st, en) in rows:
            click.echo(f'    seg_id={seg_id:>4} len={seg_len:>5} avg_logprob={avg_lp:.3f} char_off={ch_off} time=[{st:.2f},{en:.2f}]')
    else:
        click.echo('No documents found.')
