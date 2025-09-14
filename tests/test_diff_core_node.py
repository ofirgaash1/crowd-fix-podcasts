import os
import subprocess
from pathlib import Path


def test_diff_core_determinism_node():
    repo_root = Path(__file__).resolve().parents[1]
    script = repo_root / 'tests' / 'js' / 'diff_determinism.mjs'
    # Node should be available on GitHub runners; locally this test will be skipped if missing
    try:
        subprocess.check_output(['node', '--version'])
    except Exception:
        import pytest
        pytest.skip('node not available')
    # Run the ES module test
    out = subprocess.check_output(['node', str(script)], cwd=str(repo_root))
    assert b'OK' in out

