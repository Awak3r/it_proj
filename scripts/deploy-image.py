#!/usr/bin/python3
"""Receive a validated gzip docker-save image; deploy only app with backup/rollback."""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import tarfile
import tempfile

APP = Path('/home/ubuntu/labturn/source')
OPS = Path('/home/ubuntu/labturn/ops')
RELEASE_ENV = OPS / 'image.env'
DOCKER = '/usr/bin/docker'
URL = 'https://labturn.awak3r.ru'
CONNECTION_SIGNALS = (signal.SIGHUP, signal.SIGTERM, signal.SIGINT)


class DeploymentError(Exception):
    pass


@contextmanager
def protected_cleanup():
    previous = {number: signal.signal(number, signal.SIG_IGN) for number in CONNECTION_SIGNALS}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def interrupted(number, _frame):
    raise DeploymentError(f'Deployment interrupted by signal {number}')


def stop_child(process):
    with protected_cleanup():
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=10)


def run(args, *, label, timeout=240, capture=False, input_file=None):
    process = subprocess.Popen(args, cwd=APP,
                               stdin=input_file if input_file is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE if capture else None,
                               stderr=subprocess.PIPE if capture else None,
                               text=True, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except BaseException:
        stop_child(process)
        raise
    if process.returncode:
        # Captured Compose/image configuration can contain secrets; never print it.
        raise DeploymentError(f'{label} failed (exit {process.returncode}); details suppressed')
    return output if capture else None


def validate_tag(image):
    if not re.fullmatch(r'labturn-app:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', image or ''):
        raise DeploymentError('Expected a versioned labturn-app:tag')
    if image == 'labturn-app:latest':
        raise DeploymentError('The mutable latest tag is not allowed for a release')
    return image


def current_image():
    values = [line.removeprefix('LABTURN_IMAGE=') for line in RELEASE_ENV.read_text().splitlines()
              if line.startswith('LABTURN_IMAGE=')]
    if len(values) != 1:
        raise DeploymentError('image.env must contain exactly one LABTURN_IMAGE')
    return validate_tag(values[0])


def compose(*args):
    return [DOCKER, 'compose', '--project-name', 'labturn', '--profile', 'https',
            '--env-file', str(APP / '.env'), '--env-file', str(RELEASE_ENV),
            '-f', str(APP / 'compose.yaml'), '-f', str(APP / 'compose.production.yaml'), *args]


def validate_config():
    if (APP / '.env').stat().st_mode & 0o077:
        raise DeploymentError('Server .env must have mode 600 or stricter')
    config = json.loads(run(compose('config', '--format', 'json'),
                            label='Compose configuration', capture=True))
    services = config['services']
    app = services['app']
    env = app.get('environment', {})
    if app.get('build') or app.get('pull_policy') != 'never':
        raise DeploymentError('Production must use a local prebuilt image, without build/pull')
    if app.get('image') != current_image():
        raise DeploymentError('Resolved image differs from image.env')
    roots = str(env.get('ROOT_TELEGRAM_IDS', '')).split(',')
    if env.get('DEV_AUTH') != 'false' or '1297278646' not in [v.strip() for v in roots]:
        raise DeploymentError('Unexpected production authentication/root configuration')
    if not env.get('BOT_TOKEN') or env.get('APP_URL') != URL:
        raise DeploymentError('Missing bot token or unexpected APP_URL')
    if services['db'].get('ports'):
        raise DeploymentError('PostgreSQL must not publish ports')
    if any(port.get('host_ip') not in ('127.0.0.1', '::1') for port in app.get('ports', [])):
        raise DeploymentError('Application ports must be loopback-only')


def image_settings(image):
    template = ('{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
                '"config":{{json .Config}},"layers":{{json .RootFS.Layers}}}')
    return json.loads(run([DOCKER, 'image', 'inspect', '--format', template, image],
                           label='Image inspection', capture=True))


def image_info(image):
    settings = image_settings(image)
    if (settings['os'], settings['architecture']) != ('linux', 'amd64'):
        raise DeploymentError('Expected a linux/amd64 image')
    return settings['id']


def write_image(image):
    validate_tag(image)
    fd, temporary = tempfile.mkstemp(prefix='.image-', dir=OPS)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(f'LABTURN_IMAGE={image}\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, RELEASE_ENV)
    finally:
        Path(temporary).unlink(missing_ok=True)


def receive_archive(path):
    def timed_out(_number, _frame):
        raise DeploymentError('Receiving the image exceeded 15 minutes')

    previous = signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(900)
    try:
        print('Receiving gzip image into a private temporary file; app is still running', flush=True)
        total = 0
        with gzip.GzipFile(fileobj=sys.stdin.buffer) as incoming, path.open('wb') as output:
            while chunk := incoming.read(64 * 1024):
                total += len(chunk)
                if total > 4 * 1024**3:
                    raise DeploymentError('Uncompressed image archive exceeds 4 GiB')
                output.write(chunk)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def validate_archive(path, image):
    with tarfile.open(path, 'r:') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        normalized = [PurePosixPath(name) for name in names]
        if (len(normalized) != len(set(normalized))
                or any(name.is_absolute() or '..' in name.parts for name in normalized)
                or any(not (member.isfile() or member.isdir()) for member in members)):
            raise DeploymentError('Unsafe or duplicate archive entries are not allowed')

        def read(name):
            parts = PurePosixPath(name)
            if parts.is_absolute() or '..' in parts.parts:
                raise DeploymentError('Unsafe archive metadata path')
            member = archive.getmember(name)
            if not member.isfile() or member.size > 4 * 1024**2:
                raise DeploymentError('Invalid archive metadata')
            return archive.extractfile(member).read()

        manifest = json.loads(read('manifest.json'))
        if len(manifest) != 1 or manifest[0].get('RepoTags') != [image]:
            raise DeploymentError('Archive must contain exactly the requested image/tag')
        config_name = manifest[0]['Config']
        data = read(config_name)
        digest = PurePosixPath(config_name).name.removesuffix('.json')
        if not re.fullmatch(r'[a-f0-9]{64}', digest) or hashlib.sha256(data).hexdigest() != digest:
            raise DeploymentError('Image configuration digest mismatch')
        config = json.loads(data)
        if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
            raise DeploymentError('Archive image must be linux/amd64')
        if 'index.json' in names:
            descriptors = json.loads(read('index.json')).get('manifests', [])
            if len(descriptors) != 1:
                raise DeploymentError('Archive must have one top-level OCI image')
            annotations = descriptors[0].get('annotations', {})
            allowed_names = (image, 'docker.io/library/' + image)
            if annotations.get('io.containerd.image.name', image) not in allowed_names:
                raise DeploymentError('Unexpected OCI image name')
            tag = image.split(':', 1)[1]
            if annotations.get('org.opencontainers.image.ref.name', tag) not in (*allowed_names, tag):
                raise DeploymentError('Unexpected OCI image tag')
        if 'repositories' in names:
            repositories = json.loads(read('repositories'))
            if set(repositories) != {'labturn-app'} or set(repositories['labturn-app']) != {image.split(':', 1)[1]}:
                raise DeploymentError('Unexpected legacy archive tags')
        return config


def matches_archive(settings, config):
    if (settings['os'], settings['architecture']) != (config['os'], config['architecture']):
        return False
    if settings['layers'] != config.get('rootfs', {}).get('diff_ids'):
        return False
    expected = config.get('config', {})
    actual = settings['config']
    keys = ('Env', 'Cmd', 'Entrypoint', 'WorkingDir', 'User', 'ExposedPorts', 'Labels',
            'Healthcheck', 'StopSignal', 'Shell', 'Volumes')
    return all((actual.get(key) or None) == (expected.get(key) or None) for key in keys)


def import_image(path, image, config):
    existing = None
    try:
        existing = image_settings(image)
    except DeploymentError:
        pass
    if existing is not None:
        if not matches_archive(existing, config):
            raise DeploymentError('Release tag already exists with different contents; use a new tag')
        print('Identical image is already imported; preserving its tag', flush=True)
    else:
        with path.open('rb') as source:
            run([DOCKER, 'image', 'load'], label='Image import', input_file=source)
    settings = image_settings(image)
    if not matches_archive(settings, config):
        raise DeploymentError('Imported image does not match archive configuration/layers')
    return settings['id']


def health_checks():
    run(['/usr/local/sbin/labturn-check-http'],
        label='Public read-only acceptance checks', timeout=300)


def deploy(image, identifier):
    previous_pointer = current_image()

    run(['/usr/local/sbin/labturn-backup'], label='Pre-deployment backup', timeout=900)
    previous_id = run([DOCKER, 'inspect', '--format', '{{.Image}}', 'labturn-app-1'],
                      label='Running image inspection', capture=True).strip()
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    rollback = f'labturn-app:rollback-{stamp}-{os.getpid()}'
    run([DOCKER, 'image', 'tag', previous_id, rollback], label='Rollback image preservation')
    print(f'Previous image preserved: {rollback}', flush=True)
    activated = False
    try:
        activated = True
        write_image(image)
        validate_config()
        run(compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    '--wait', '--wait-timeout', '180', 'app'), label='Application replacement')
        health_checks()
    except BaseException:
        if activated:
            # Repeated connection signals must not interrupt restoration of the old app.
            with protected_cleanup():
                try:
                    write_image(rollback)
                    run(compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                                '--wait', '--wait-timeout', '180', 'app'), label='Application rollback')
                    health_checks()
                except Exception:
                    raise DeploymentError(f'Rollback needs operator attention; previous image is {rollback}') from None
        raise
    history = OPS / 'releases'
    history.mkdir(mode=0o700, exist_ok=True)
    receipt = {'deployed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
               'image': image, 'image_id': identifier,
               'previous_pointer': previous_pointer, 'rollback_image': rollback,
               'checks': 'health/config/HTML/assets and unauthorized state/updates passed',
               'telegram_login_sse': 'not repeated automatically; real Telegram session required'}
    (history / f'{stamp}-{os.getpid()}.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Deployed {image}; {URL}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Check setup without loading/restarting')
    modes.add_argument('--load-only', action='store_true', help='Import/validate image, do not deploy')
    parser.add_argument('image', nargs='?')
    options = parser.parse_args()
    if options.check and options.image:
        parser.error('--check does not take an image')
    if not options.check:
        validate_tag(options.image)
    if os.geteuid() != 0:
        raise DeploymentError('Run the installed receiver with sudo -n')
    for number in CONNECTION_SIGNALS:
        signal.signal(number, interrupted)
    os.umask(0o077)
    with open('/run/lock/labturn-deploy.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('Another LabTurn deployment is in progress') from None
        validate_config()
        if options.check:
            image_info(current_image())
            print('Receiver ready: no server build/pull, production auth enabled, DB private')
            return
        with tempfile.TemporaryDirectory(prefix='.receive-image-', dir=OPS) as directory:
            archive = Path(directory) / 'image.tar'
            receive_archive(archive)
            config = validate_archive(archive, options.image)
            identifier = import_image(archive, options.image, config)
        if options.load_only:
            print(f'Image validated: {options.image} {identifier}; nothing restarted')
            return
        deploy(options.image, identifier)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('Deployment interrupted')
    except Exception as error:
        if isinstance(error, DeploymentError):
            sys.exit(str(error))
        sys.exit(f'Deployment failed: {type(error).__name__}; sensitive details suppressed')
