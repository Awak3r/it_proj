#!/usr/bin/python3
"""Release-tool unit checks; no Docker, SSH, Telegram or production DB calls."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


receiver = module('labturn_receiver', 'deploy-image.py')

ci = module('labturn_ci', 'ci-ssh-command.py')
authorizer = module('labturn_authorizer', 'authorize-ci-key.py')


class ReleaseTests(unittest.TestCase):
    def test_versioned_image(self):
        image = 'labturn-app:pc-20261114T220000Z-95dc9e37c557-snapshot'
        self.assertEqual(receiver.validate_tag(image), image)

    def test_reject_unsafe_or_mutable_tags(self):
        for value in [None, '', 'labturn-app:latest', 'postgres:17', 'x/labturn-app:v1',
                      'labturn-app:x;echo', 'labturn-app:x y', 'labturn-app:../x',
                      'labturn-app:' + 'x' * 129]:
            with self.subTest(value=value), self.assertRaises(receiver.DeploymentError):
                receiver.validate_tag(value)

    def test_atomic_private_release_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            ops = Path(directory)
            with patch.object(receiver, 'OPS', ops), patch.object(receiver, 'RELEASE_ENV', ops / 'image.env'):
                receiver.write_image('labturn-app:first')
                self.assertEqual(receiver.current_image(), 'labturn-app:first')
                self.assertEqual((ops / 'image.env').stat().st_mode & 0o777, 0o600)
                receiver.write_image('labturn-app:second')
                self.assertEqual(receiver.current_image(), 'labturn-app:second')
                self.assertEqual(list(ops.glob('.image-*')), [])

    def test_reject_duplicate_release_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'image.env'
            target.write_text('LABTURN_IMAGE=labturn-app:a\nLABTURN_IMAGE=labturn-app:b\n')
            with patch.object(receiver, 'RELEASE_ENV', target), self.assertRaises(receiver.DeploymentError):
                receiver.current_image()

    def test_accept_amd64(self):
        with patch.object(receiver, 'image_settings', return_value={
                'os': 'linux', 'architecture': 'amd64', 'id': 'sha256:123'}):
            self.assertEqual(receiver.image_info('labturn-app:v1'), 'sha256:123')

    def test_reject_wrong_architecture(self):
        with patch.object(receiver, 'image_settings', return_value={
                'os': 'linux', 'architecture': 'arm64', 'id': 'sha256:123'}):
            with self.assertRaises(receiver.DeploymentError):
                receiver.image_info('labturn-app:v1')

    def test_compose_failure_does_not_disclose_captured_output(self):
        process = Mock(returncode=1)
        process.communicate.return_value = ('PRIVATE_SENTINEL', 'PRIVATE_SENTINEL')
        with patch.object(receiver.subprocess, 'Popen', return_value=process):
            with self.assertRaises(receiver.DeploymentError) as caught:
                receiver.run(['not-executed'], label='Compose validation', capture=True)
        self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))

    def archive(self, directory, tags=None, architecture='amd64'):
        config = {'os': 'linux', 'architecture': architecture,
                  'rootfs': {'diff_ids': ['sha256:layer']}, 'config': {'User': 'app'}}
        data = json.dumps(config).encode()
        name = 'blobs/sha256/' + hashlib.sha256(data).hexdigest()
        manifest = [{'Config': name, 'RepoTags': tags or ['labturn-app:v1'], 'Layers': []}]
        target = Path(directory) / 'image.tar'
        with tarfile.open(target, 'w') as output:
            for filename, content in [(name, data), ('manifest.json', json.dumps(manifest).encode())]:
                entry = tarfile.TarInfo(filename)
                entry.size = len(content)
                output.addfile(entry, io.BytesIO(content))
        return target, config

    def test_archive_is_bound_to_requested_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            path, config = self.archive(directory)
            self.assertEqual(receiver.validate_archive(path, 'labturn-app:v1'), config)
            with self.assertRaises(receiver.DeploymentError):
                receiver.validate_archive(path, 'labturn-app:other')

    def test_archive_rejects_extra_tags_and_wrong_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _ = self.archive(directory, tags=['labturn-app:v1', 'postgres:17'])
            with self.assertRaises(receiver.DeploymentError):
                receiver.validate_archive(path, 'labturn-app:v1')
            path, _ = self.archive(directory, architecture='arm64')
            with self.assertRaises(receiver.DeploymentError):
                receiver.validate_archive(path, 'labturn-app:v1')

    def test_existing_tag_cannot_be_overwritten_with_different_contents(self):
        config = {'os': 'linux', 'architecture': 'amd64', 'rootfs': {'diff_ids': ['new']}, 'config': {}}
        settings = {'os': 'linux', 'architecture': 'amd64', 'layers': ['old'], 'config': {}}
        with patch.object(receiver, 'image_settings', return_value=settings), patch.object(receiver, 'run') as run:
            with self.assertRaises(receiver.DeploymentError):
                receiver.import_image(Path('not-opened'), 'labturn-app:v1', config)
            run.assert_not_called()

    def test_signal_becomes_a_controlled_failure(self):
        with self.assertRaises(receiver.DeploymentError):
            receiver.interrupted(signal.SIGHUP, None)

    def test_failed_switch_restores_old_image_without_restoring_database(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if 'inspect' in args:
                return 'sha256:old\n'
            if 'up' in args and sum('up' in call for call in calls) == 1:
                raise receiver.DeploymentError('simulated switch failure')
            return None

        with patch.object(receiver, 'current_image', return_value='labturn-app:old'), \
             patch.object(receiver, 'run', side_effect=fake_run), \
             patch.object(receiver, 'write_image') as write, \
             patch.object(receiver, 'validate_config'), patch.object(receiver, 'health_checks'):
            with self.assertRaises(receiver.DeploymentError):
                receiver.deploy('labturn-app:new', 'sha256:new')
        self.assertEqual(write.call_args_list[0].args, ('labturn-app:new',))
        self.assertTrue(write.call_args_list[1].args[0].startswith('labturn-app:rollback-'))
        self.assertEqual(sum('up' in call for call in calls), 2)
        self.assertFalse(any('pg_restore' in call for call in calls))


    def test_same_pointer_still_reconciles_the_running_image(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            return 'sha256:old\n' if 'inspect' in args else None

        with tempfile.TemporaryDirectory() as directory, \
             patch.object(receiver, 'OPS', Path(directory)), \
             patch.object(receiver, 'current_image', return_value='labturn-app:new'), \
             patch.object(receiver, 'run', side_effect=fake_run), \
             patch.object(receiver, 'write_image'), \
             patch.object(receiver, 'validate_config'), patch.object(receiver, 'health_checks'):
            receiver.deploy('labturn-app:new', 'sha256:new')
        self.assertEqual(sum('up' in call for call in calls), 1)

    def test_build_is_amd64_and_never_connects_to_the_server(self):
        stub = '''#!/usr/bin/python3
import json,os,pathlib,sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ["RELEASE_TEST_LOG"],"a") as output:
 output.write(json.dumps([name,args])+"\\n")
if name=="ssh": sys.exit(99)
if args[:2]==["image","inspect"]: sys.exit(1)
'''
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            for name in ['docker', 'ssh']:
                target = folder / name
                target.write_text(stub)
                target.chmod(0o755)
            log = folder / 'calls.jsonl'
            environment = {**os.environ, 'PATH': str(folder) + os.pathsep + os.environ['PATH'],
                           'RELEASE_TEST_LOG': str(log)}
            result = subprocess.run(['bash', str(HERE / 'build-image.sh'),
                                     'labturn-app:unit-release'], env=environment,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            build = next(args for name, args in calls if name == 'docker' and args[:2] == ['buildx', 'build'])
            self.assertEqual(build[build.index('--platform') + 1], 'linux/amd64')
            self.assertIn('--load', build)
            self.assertFalse(any(name == 'ssh' for name, _ in calls))

    def test_ci_key_can_only_check_or_deploy_github_tags(self):
        self.assertEqual(ci.receiver_command('labturn-check')[-1], '--check')
        image = 'labturn-app:gh-' + 'a' * 40 + '-123-1'
        self.assertEqual(ci.receiver_command('labturn-deploy ' + image)[-1], image)
        for command in ['', '/bin/sh', 'labturn-check extra', 'labturn-check; cat .env',
                        'labturn-deploy labturn-app:latest', 'sudo -n docker ps',
                        'labturn-deploy ' + image + ' && whoami']:
            with self.subTest(command=command), self.assertRaises(ValueError):
                ci.receiver_command(command)

    def test_public_ci_key_receives_forced_command_restrictions(self):
        wire = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32) + bytes(range(32))
        public = 'ssh-ed25519 ' + base64.b64encode(wire).decode() + ' local-comment'
        line = authorizer.restricted_line(public)
        self.assertTrue(line.startswith('restrict,command="/usr/local/sbin/labturn-ci-ssh" ssh-ed25519 '))
        self.assertTrue(line.endswith(' labturn-github-actions'))
        self.assertNotIn('local-comment', line)
        for value in ['-----BEGIN OPENSSH PRIVATE KEY-----', 'ssh-rsa aaaa', public + '\n' + public]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                authorizer.restricted_line(value)



if __name__ == '__main__':
    unittest.main(verbosity=2)
