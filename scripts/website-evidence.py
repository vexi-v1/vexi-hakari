#!/usr/bin/env python3
"""Generate public website evidence from real, local fork executions. Never broadcasts."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'website/evidence'
SCENARIOS = ('lifecycle', 'anchor', 'delayed', 'refund', 'unguarded')

def run(*args, cwd=ROOT, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True)

def inputs():
    paths = []
    for folder in ('src', 'aqua/src', 'aqua/test'):
        paths += [p for p in (ROOT / folder).rglob('*.sol') if p.is_file()]
    for name in ('foundry.toml', 'remappings.txt', 'aqua/foundry.toml', 'aqua/remappings.txt', '.gitmodules',
                 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/website-evidence.py'):
        paths.append(ROOT / name)
    paths += list((ROOT / 'LICENSES').glob('*.txt'))
    return sorted(set(p for p in paths if p.exists()))

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, RH_MAINNET_RPC=os.environ.get('RH_MAINNET_RPC', 'https://rpc.ordofi.network'),
               RH_MAINNET_FORK_BLOCK='72248228', EXPORT_WEBSITE='true',
               FOUNDRY_DISABLE_NIGHTLY_WARNING='1', NO_COLOR='1')
    # RPC and fork pin are explicit inputs. Never copy environment values into public evidence.
    for name in SCENARIOS:
        (ROOT / f'aqua/deployments/website-{name}.json').unlink(missing_ok=True)
    command = ['forge', 'test', '--match-contract', '^WebsiteEvidenceTest$', '-vvvv']
    print('Executing five scenarios on the pinned local fork...', flush=True)
    result = subprocess.run(command, cwd=ROOT / 'aqua', env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    if result.returncode:
        # Error output can include endpoint information; keep it local, never publish a failed run.
        diagnostic = Path(tempfile.gettempdir()) / 'hakari-website-evidence-failure.txt'
        diagnostic.write_text(result.stdout)
        raise SystemExit(f'Foundry failed; local diagnostic: {diagnostic}')
    assert '5 passed; 0 failed' in result.stdout, 'Unexpected test count'
    scenarios = []
    for name in SCENARIOS:
        data = json.loads((ROOT / f'aqua/deployments/website-{name}.json').read_text())
        if isinstance(data['steps'], str):
            data['steps'] = json.loads(data['steps'])
        for step in data['steps']:
            if isinstance(step['logs'], str):
                step['logs'] = json.loads(step['logs'])
        assert data['scenario'] == name and data['steps']
        scenarios.append(data)
    paths = inputs()
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    tracked_status = run('git', 'status', '--porcelain', '--', *hashes.keys()).strip()
    submodules = run('git', 'submodule', 'status', '--recursive').strip()
    assert not any(line.startswith(('+', 'U')) for line in submodules.splitlines()), 'Submodule pin mismatch'
    assert not any(line.startswith('-') for line in run('git', 'submodule', 'status').splitlines()), 'Initialize direct submodules'
    # Uninitialized nested upstream test dependencies are recorded but not used by this project.
    trace = result.stdout.replace(env['RH_MAINNET_RPC'], '[read-only archive RPC]')
    # Do not publish environment values or raw RPC endpoints in the call trace.
    trace = '\n'.join(line for line in trace.splitlines() if 'envString(' not in line) + '\n'
    with tempfile.TemporaryDirectory(prefix='hakari-website-') as temp:
        stage = Path(temp)
        (stage / 'trace.txt').write_text(trace)
        (stage / 'source-files.json').write_text(json.dumps(hashes, indent=2) + '\n')
        with zipfile.ZipFile(stage / 'source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for p in paths:
                info = zipfile.ZipInfo(str(p.relative_to(ROOT)), (2026, 9, 27, 0, 0, 0))
                archive.writestr(info, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        manifest = {
            'schemaVersion': 1, 'mode': 'local-fork', 'chainId': 4663, 'forkBlock': 72248228,
            'sourceRevision': run('git', 'rev-parse', 'HEAD').strip(),
            'sourceInputsModified': bool(tracked_status), 'sourceFingerprint': fingerprint,
            'forgeVersion': run('forge', '--version').strip(), 'submodules': submodules,
            'command': 'python3 scripts/website-evidence.py', 'passedTests': len(scenarios),
            'scenarios': scenarios,
            'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.iterdir()},
        }
        (stage / 'demo.json').write_text(json.dumps(manifest, indent=2) + '\n')
        for p in stage.iterdir():
            p.replace(OUT / p.name)
    print(f'Exported {len(scenarios)} scenarios; source fingerprint {fingerprint}')

if __name__ == '__main__':
    main()
