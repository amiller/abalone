import importlib.util
import json
import os
import tempfile
from pathlib import Path
import subprocess
import sys
import time
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


projector, consumer = load('project-status'), load('status-line')
BOOT = '12345678-1234-1234-1234-123456789abc'
INVOCATION = 'a' * 32


def snapshot(pid='432', active='active', invocation=INVOCATION):
    return f'ActiveState={active}\nMainPID={pid}\nInvocationID={invocation}\nExecMainStartTimestampMonotonic=1000\n'


def journal(progress=100, **changes):
    entry = {'_PID': '432', '_BOOT_ID': BOOT.replace('-', ''), '_SYSTEMD_UNIT': 'tor-guest.service',
             '_SYSTEMD_INVOCATION_ID': INVOCATION, '__MONOTONIC_TIMESTAMP': '2000',
             'MESSAGE': f'Bootstrapped {progress}% (done): Done'}
    entry.update(changes)
    return json.dumps(entry) + '\n'


def collect(messages=None, first=None, second=None):
    values = [first or snapshot(), journal() if messages is None else messages, second or first or snapshot()]
    commands = []
    def run(args, **kwargs):
        commands.append(args)
        return values[len(commands)-1]
    result = projector.project(run, BOOT)
    return result, commands


class Projection(unittest.TestCase):
    def test_current_process_bootstrap(self):
        result, commands = collect()
        self.assertEqual(result, {'state': 'bootstrapped', 'progress': 100})
        self.assertIn('_PID=432', commands[1])
        self.assertIn('_SYSTEMD_INVOCATION_ID=' + INVOCATION, commands[1])
        self.assertIn('--boot=0', commands[1])

    def test_latest_bootstrap_can_regress(self):
        result, _ = collect(journal() + journal(20, __MONOTONIC_TIMESTAMP='3000'))
        self.assertEqual(result, {'state': 'starting', 'progress': 20})

    def test_old_pid_boot_invocation_or_timestamp_ignored(self):
        for changed in ({'_PID': '431'}, {'_BOOT_ID': 'b'*32}, {'_SYSTEMD_INVOCATION_ID': 'b'*32},
                        {'_SYSTEMD_UNIT': 'other.service'}, {'__MONOTONIC_TIMESTAMP': '999'}):
            with self.subTest(changed=changed):
                self.assertEqual(collect(journal(**changed))[0]['state'], 'unknown')

    def test_restarted_during_collection(self):
        self.assertEqual(collect(second=snapshot(pid='433'))[0]['state'], 'unknown')
        self.assertEqual(collect(second=snapshot(invocation='b'*32))[0]['state'], 'unknown')

    def test_stopped_resets_ready_without_journal(self):
        result, commands = collect(first=snapshot(pid='0', active='inactive'))
        self.assertEqual(result, {'state': 'stopped', 'progress': None})
        self.assertEqual(len(commands), 1)

    def test_missing_bootstrap_and_malformed_journal_unknown(self):
        for raw in ('', 'invalid JSON', '[]', journal(101), journal(MESSAGE=['Bootstrapped 100%'])):
            with self.subTest(raw=raw):
                self.assertEqual(collect(raw)[0]['state'], 'unknown')

    def test_unknown_unit_command_failure(self):
        def fail(*args, **kwargs):
            raise subprocess.TimeoutExpired('fixture', 1)
        self.assertEqual(projector.project(fail, BOOT)['state'], 'unknown')
        self.assertEqual(collect(first='ActiveState=active\n')[0]['state'], 'unknown')

    def test_command_timeout_and_output_limit(self):
        before = time.monotonic()
        with self.assertRaises(ValueError):
            projector.bounded_run([sys.executable, '-c', 'import time;time.sleep(5)'], timeout=.05)
        self.assertLess(time.monotonic() - before, 1)
        with self.assertRaises(ValueError):
            projector.bounded_run([sys.executable, '-c', 'print("x"*4096)'], limit=16)


class Consumer(unittest.TestCase):
    def data(self):
        return {'version': 1, 'boot_id': BOOT, 'observed_boottime': 100,
                'tor': {'state': 'bootstrapped', 'progress': 100}, 'credit': {'state': 'unknown'}}

    def test_truthful_bootstrap_and_credit(self):
        data = self.data()
        data['credit'] = {'state': 'funded', 'balance': '$4.82'}
        text = consumer.render(data, BOOT, 101)
        self.assertIn('Tor bootstrap 100%', text)
        self.assertIn('Credit unknown', text)
        self.assertNotIn('$4.82', text)

    def test_stale_old_boot_future_missing_unknown(self):
        for data, boot, now in ((self.data(), BOOT, 116), (self.data(), 'other', 101),
                                (self.data(), BOOT, 99), ({}, BOOT, 101)):
            self.assertTrue(consumer.render(data, boot, now).startswith('Tor unknown'))

    @unittest.skipUnless(os.geteuid() == 0, 'run in unshare -Ur for ownership checks')
    def test_atomic_public_file_and_untrusted_files(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o755)
            projector.publish(directory, self.data())
            self.assertEqual(consumer.read_public(directory), self.data())
            path = Path(directory) / 'status.json'
            os.chmod(path, 0o666)
            with self.assertRaises(ValueError):
                consumer.read_public(directory)
            path.unlink()
            path.symlink_to('/dev/zero')
            with self.assertRaises(OSError):
                consumer.read_public(directory)
            path.unlink()
            path.write_text('x' * 1025)
            with self.assertRaises(ValueError):
                consumer.read_public(directory)
            os.chmod(directory, 0o777)
            with self.assertRaises(PermissionError):
                projector.publish(directory, self.data())

    def test_untrusted_labels_not_rendered(self):
        data = self.data()
        data['tor'] = {'state': '\x1b[31mEVIL', 'progress': '100\nEVIL'}
        self.assertNotIn('EVIL', consumer.render(data, BOOT, 101))


if __name__ == '__main__':
    unittest.main(verbosity=2)
