"""Synthetic digest/nonce negative fixtures; no network or credentials."""
import importlib.util
import hashlib
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).resolve().parents[1] / 'tools/near-deployment-evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)
NONCE = 'ab' * 32


def fixture(actions=None, encoding='canonical-string-v1'):
    actions = actions or [{'timestamp': 'now', 'action': 'compose_up', 'file': 'résumé[\\"].yaml', 'services': ['one', 'two']}]
    encoded = evidence.canonical_actions(actions) if encoding == 'canonical-string-v1' else json.dumps(actions)
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    cm = {'actions': actions, 'actions_hash': digest, 'nonce': NONCE, 'nonce_source': 'client', 'report_data': digest + NONCE}
    return {'gateway_attestation': {'request_nonce': NONCE}, 'model_attestations': [{'request_nonce': NONCE, 'compose_manager_attestation': cm}]}


class EvidenceTests(unittest.TestCase):
    def inspect(self, report, nonce=NONCE, encoding='canonical-string-v1'):
        return evidence.inspect(json.dumps(report, indent=2, ensure_ascii=False).encode(), nonce, encoding)

    def test_canonical_digest_survives_key_order_and_whitespace(self):
        report = fixture()
        cm = report['model_attestations'][0]['compose_manager_attestation']
        cm['actions'][0] = dict(reversed(list(cm['actions'][0].items())))
        result = self.inspect(report)
        self.assertFalse(result['managers'][0]['quote_verified'])
        self.assertFalse(result['private_work_enabled'])

    def test_altered_actions_rejected(self):
        report = fixture()
        report['model_attestations'][0]['compose_manager_attestation']['actions'][0]['file'] = 'other'
        with self.assertRaisesRegex(ValueError, 'digest'):
            self.inspect(report)

    def test_nonce_swaps_rejected(self):
        for who in ['gateway', 'model', 'manager']:
            with self.subTest(who=who):
                report = fixture()
                if who == 'gateway':
                    report['gateway_attestation']['request_nonce'] = 'cd' * 32
                elif who == 'model':
                    report['model_attestations'][0]['request_nonce'] = 'cd' * 32
                else:
                    report['model_attestations'][0]['compose_manager_attestation']['nonce'] = 'cd' * 32
                with self.assertRaisesRegex(ValueError, 'nonce'):
                    self.inspect(report)

    def test_report_data_rejected(self):
        report = fixture()
        report['model_attestations'][0]['compose_manager_attestation']['report_data'] = '00' * 64
        with self.assertRaisesRegex(ValueError, 'report-data'):
            self.inspect(report)

    def test_duplicates_and_numeric_schema_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            evidence.inspect(b'{"x":1,"x":2}', NONCE)
        for value in [1, 1.5, True, {'nested': 'value'}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                evidence.canonical_actions([{'timestamp': 'now', 'action': 'compose_up', 'tag': value}])
        with self.assertRaisesRegex(ValueError, 'schema'):
            evidence.canonical_actions([{'timestamp': 'now', 'action': 'compose_up', 'unknown': 'value'}])

    def test_raw_path_handles_escaped_brackets_and_nested_values(self):
        text = '{"outside":[],"models":[{"actions": [ {"name":"a]\\\"b", "values":[1,2]} ]}]}'
        evidence.DECODER.decode(text)
        self.assertEqual(evidence.raw_path(text, ['models', 0, 'actions']), '[ {"name":"a]\\\"b", "values":[1,2]} ]')

    def test_exact_mode_is_explicit_and_reformatting_refused(self):
        report = fixture(encoding='exact')
        raw = json.dumps(report).encode()
        self.assertTrue(evidence.inspect(raw, NONCE, 'exact')['managers'][0]['nonce_matches'])
        with self.assertRaisesRegex(ValueError, 'digest'):
            self.inspect(report, encoding='exact')
        with self.assertRaises(ValueError):
            evidence.inspect(raw, NONCE, 'unknown')


if __name__ == '__main__':
    unittest.main()
