#!/usr/bin/python3
"""Append a restricted public CI key without changing the owner's existing SSH keys."""
import base64
import fcntl
import os
from pathlib import Path
import pwd
import struct
import sys

DISPATCHER = '/usr/local/sbin/labturn-ci-ssh'


def restricted_line(text):
    if '\n' in text.strip() or '\r' in text.strip():
        raise ValueError('Provide exactly one public SSH key line')
    parts = text.strip().split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise ValueError('Only an ssh-ed25519 public key is accepted; never provide a private key')
    try:
        data = base64.b64decode(parts[1], validate=True)
        prefix = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32)
        if not data.startswith(prefix) or len(data) != len(prefix) + 32:
            raise ValueError('Invalid ED25519 key')
    except Exception:
        raise ValueError('Invalid ED25519 public key') from None
    canonical = base64.b64encode(data).decode()
    return f'restrict,command="{DISPATCHER}" ssh-ed25519 {canonical} labturn-github-actions'


def main():
    owner = pwd.getpwnam('ubuntu')
    if os.geteuid() not in (0, owner.pw_uid):
        sys.exit('Run as the deployment owner ubuntu or root')
    if not Path(DISPATCHER).is_file():
        sys.exit('Install the root-owned CI dispatcher first')
    line = restricted_line(sys.stdin.read(8193))
    home = Path(owner.pw_dir)
    directory = home / '.ssh'
    if directory.is_symlink():
        sys.exit('Refusing a symlinked .ssh directory')
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    path = directory / 'authorized_keys'
    descriptor = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        with os.fdopen(descriptor, 'r+', closefd=False) as target:
            existing = target.read()
            if line in existing.splitlines():
                print('Restricted CI public key is already installed')
                return
            material = line.split(' ssh-ed25519 ', 1)[1].split()[0]
            if material in existing:
                sys.exit('This key already has another authorization; use a separate dedicated CI key')
            target.write(('\n' if existing and not existing.endswith('\n') else '') + line + '\n')
            target.flush()
            os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
        if os.geteuid() == 0:
            os.fchown(descriptor, owner.pw_uid, owner.pw_gid)
            os.chown(directory, owner.pw_uid, owner.pw_gid)
    finally:
        os.close(descriptor)
    print('Restricted CI public key installed; existing owner keys preserved')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
