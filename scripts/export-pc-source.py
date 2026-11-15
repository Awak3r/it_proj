#!/usr/bin/python3
"""Export the current public source snapshot, never production .env/backups/Git data."""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import os

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT_FILES = {'.dockerignore', '.gitignore', '.env.example', 'AGENTS.md', 'Caddyfile',
                     'Dockerfile', 'README.md', 'compose.yaml', 'compose.production.yaml'}
PUBLIC_TREES = {'.github', 'backend', 'deploy', 'docs', 'scripts', 'web'}
EXCLUDED_PARTS = {'.git', 'node_modules', 'dist', 'test-results', 'playwright-report',
                  '__pycache__', 'backups'}
# Only reviewed additions may accompany the trusted tracked source tree.
LOCAL_SOURCE_ADDITIONS = {
    'AGENTS.md', 'compose.production.yaml', 'docs/DEPLOYMENT-PC.md', 'web/tests/safe-area.spec.ts',
    'scripts/build-image.sh', 'scripts/compose-production.sh', 'scripts/deploy-image.py',
    'scripts/ci-ssh-command.py', 'scripts/authorize-ci-key.py',
    'scripts/check-production.py', 'scripts/backup-postgres.py', 'scripts/configure-bot-menu.py',
    'deploy/systemd/labturn-backup.service', 'deploy/systemd/labturn-backup.timer',
    '.github/workflows/deploy.yml', '.github/vps_known_hosts',
    'docs/DEPLOYMENT-GITHUB.md', 'docs/LOCAL-AGENT-HANDOFF.md',
    'scripts/export-pc-source.py', 'scripts/test_release.py',
}


def public_source(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    if any(part in EXCLUDED_PARTS for part in path.parts):
        return False
    if any(part.startswith('.env') and part != '.env.example' for part in path.parts):
        return False
    if name.endswith(('.log', '.dump', '.tar', '.tar.gz', '.tar.zst', '.key', '.pem', '.pfx', '.p12')):
        return False
    return name in PUBLIC_ROOT_FILES or path.parts[0] in PUBLIC_TREES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parent / 'ops/labturn-pc.tar.gz')
    options = parser.parse_args()
    tracked = subprocess.run(['git', 'ls-files', '--cached', '-z'], cwd=ROOT,
                             capture_output=True, check=True).stdout
    other = subprocess.run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=ROOT,
                           capture_output=True, check=True).stdout
    names = {os.fsdecode(name) for name in tracked.split(b'\0') if name}
    names.update(os.fsdecode(name) for name in other.split(b'\0')
                 if name and os.fsdecode(name) in LOCAL_SOURCE_ADDITIONS)
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True,
                              check=True, text=True).stdout.strip()
    selected = sorted(name for name in names if public_source(name))
    output = options.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.pc-source-', dir=output.parent)
    os.close(fd)
    try:
        with tarfile.open(temporary, 'w:gz', compresslevel=1) as archive:
            for name in selected:
                path = ROOT / name
                if path.is_symlink():
                    raise RuntimeError(f'Symlinks are not exported: {name}')
                if path.is_file():
                    archive.add(path, arcname='labturn-pc/' + name, recursive=False)
            for name, value in [('SOURCE_REVISION', revision + '\n'),
                                ('SOURCE_STATE', 'snapshot with local uncommitted changes\n')]:
                content = value.encode()
                entry = tarfile.TarInfo('labturn-pc/' + name)
                entry.size = len(content)
                entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(content))
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(f'Source snapshot: {output} ({output.stat().st_size} bytes)')
    print('Production secrets, .git, database dumps, node_modules and dist are excluded')


if __name__ == '__main__':
    main()
