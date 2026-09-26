#!/usr/bin/env python3
"""Validate and stage only explicitly public website files. No network or dependencies needed."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / '_site'
ASSETS = ('style.css', 'app.js', 'band.mjs', 'i18n.mjs', 'vexi-logo.svg')
EVIDENCE = ('demo.json', 'trace.txt', 'source.zip', 'source-files.json')
LEGACY_PAGES = ('web/index.html', 'web/plain/index.html', 'web/squeeze/index.html',
                'web/live/index.html', 'web/vexi/index.html')

def main():
    evidence_dir = ROOT / 'website/evidence'
    demo = json.loads((evidence_dir / 'demo.json').read_text())
    assert demo['schemaVersion'] == 1 and demo['mode'] == 'local-fork'
    assert demo['chainId'] == 4663 and demo['forkBlock'] == 72248228
    assert demo['passedTests'] == 5 and len(demo['scenarios']) == 5
    assert [s['scenario'] for s in demo['scenarios']] == ['lifecycle', 'anchor', 'delayed', 'refund', 'unguarded']
    expected_steps = ['initial', 'ship', 'post', 'spot', 'buy', 'taper', 'pause', 'recover', 'expired',
                      'renew', 'settle', 'exercise', 'close', 'premium', 'release']
    assert [s['id'] for s in demo['scenarios'][0]['steps']] == expected_steps
    for name in EVIDENCE[1:]:
        assert hashlib.sha256((evidence_dir / name).read_bytes()).hexdigest() == demo['files'][name], f'Changed artifact: {name}'
    hashes = json.loads((evidence_dir / 'source-files.json').read_text())
    assert hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest() == demo['sourceFingerprint']
    for name, digest in hashes.items():
        path = (ROOT / name).resolve()
        assert path.is_relative_to(ROOT), 'Invalid source input path'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, f'Stale evidence: {name}; regenerate it'
    lifecycle = demo['scenarios'][0]['steps']
    # Real token conservation across all four participant accounts, excluding reference-pool trading.
    for symbol in ('Tsla', 'Usdg'):
        total = sum(int(lifecycle[0][a + symbol]) for a in ('maker', 'buyer', 'book', 'taker'))
        for step in lifecycle:
            assert total == sum(int(step[a + symbol]) for a in ('maker', 'buyer', 'book', 'taker')), f'Asset conservation: {step["id"]}'
    for scenario in demo['scenarios']:
        timestamps = [int(s['timestamp']) for s in scenario['steps']]
        assert timestamps == sorted(timestamps)
        for step in scenario['steps']:
            assert isinstance(step['logs'], list)
    if SITE.exists():
        shutil.rmtree(SITE)
    (SITE / 'website/evidence').mkdir(parents=True)
    shutil.copy2(ROOT / 'index.html', SITE / 'index.html')
    (SITE / '.nojekyll').touch()
    for name in ASSETS:
        shutil.copy2(ROOT / 'website' / name, SITE / 'website' / name)
    for name in EVIDENCE:
        shutil.copy2(evidence_dir / name, SITE / 'website/evidence' / name)
    for name in LEGACY_PAGES:
        target = SITE / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    print(f'Validated evidence, source fingerprints and token conservation. Staged {len(list(SITE.rglob("*")))} paths in {SITE}')

if __name__ == '__main__':
    main()
