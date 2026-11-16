#!/usr/bin/python3
"""Forced SSH entry point: CI may check/deploy one versioned image, never open a shell."""
import os
import re
import shlex
import sys

RECEIVER = '/usr/local/sbin/labturn-deploy-image'


def receiver_command(command):
    try:
        words = shlex.split(command)
    except ValueError:
        raise ValueError('Malformed CI command') from None
    if words == ['labturn-check']:
        return ['/usr/bin/sudo', '-n', RECEIVER, '--check']
    if (len(words) == 2 and words[0] == 'labturn-deploy'
            and re.fullmatch(r'labturn-app:gh-[a-f0-9]{40}-[0-9]+-[0-9]+', words[1])):
        return ['/usr/bin/sudo', '-n', RECEIVER, words[1]]
    raise ValueError('CI key permits only labturn-check or labturn-deploy with a GitHub release tag')


def main():
    try:
        command = receiver_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except ValueError as error:
        sys.exit(str(error))
    os.execv(command[0], command)


if __name__ == '__main__':
    main()
