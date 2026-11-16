#!/usr/bin/python3
"""Private PostgreSQL dumps; optional isolated restore verification."""
import argparse
import datetime as dt
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import time

APP = Path('/home/ubuntu/labturn/source')
BACKUPS = Path('/var/backups/labturn')
COMPOSE = ['/usr/bin/docker', 'compose', '--project-name', 'labturn']


def db(*args, **kwargs):
    return subprocess.run(COMPOSE + ['exec', '-T', 'db', *args], cwd=APP,
                          check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-restore', action='store_true')
    options = parser.parse_args()
    os.umask(0o077)
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    if BACKUPS.stat().st_mode & 0o077:
        raise RuntimeError('Backup directory must not be accessible to other users')
    with open('/run/lock/labturn-backup.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        target = BACKUPS / f'labturn-{stamp}.dump'
        fd, temporary = tempfile.mkstemp(prefix='.partial-', dir=BACKUPS)
        try:
            with os.fdopen(fd, 'wb') as output:
                db('pg_dump', '-U', 'labqueue', '-d', 'labqueue', '-Fc', stdout=output)
                output.flush()
                os.fsync(output.fileno())
            if Path(temporary).stat().st_size == 0:
                raise RuntimeError('Empty dump')
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        print(f'Backup: {target.name} ({target.stat().st_size} bytes)', flush=True)
        if options.verify_restore:
            restore_db = f'labturn_restore_{stamp.lower()}'
            db('createdb', '-U', 'labqueue', restore_db)
            try:
                with target.open('rb') as source:
                    db('pg_restore', '-U', 'labqueue', '-d', restore_db,
                       '--exit-on-error', '--no-owner', '--no-privileges', stdin=source)
                db('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'labqueue',
                   '-d', restore_db, '-c',
                   'SELECT count(*) AS restored_tables FROM information_schema.tables '
                   "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'; "
                   'SELECT count(*) AS restored_events FROM events; '
                   'SELECT count(*) AS restored_users FROM users;')
                print('Isolated restore verified', flush=True)
            finally:
                db('dropdb', '-U', 'labqueue', '--force', restore_db)
        cutoff = time.time() - 7 * 24 * 60 * 60
        for old in BACKUPS.glob('labturn-*.dump'):
            if old.is_file() and not old.is_symlink() and old.stat().st_mtime < cutoff:
                old.unlink()
        print('Retention: 7 days', flush=True)


if __name__ == '__main__':
    main()
