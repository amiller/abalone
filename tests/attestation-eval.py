#!/usr/bin/env python3
"""Offline given-evidence, hidden-answer and missing-corpus regression checks."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / 'evals/attestation/run.py'

class EvaluationBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='abalone-eval-')
        self.root = Path(self.temp.name)
        self.guide = self.root / 'guide'
        self.corpus = self.guide / 'case-studies'
        self.case = self.corpus / 'test-service'
        (self.case / 'evidence').mkdir(parents=True)
        (self.case / 'evidence/raw.json').write_text('{"synthetic":true}')
        (self.case / 'evidence/audit-note.txt').write_text('ANSWER_CANARY')
        (self.case / 'report.txt').write_text('ANSWER_CANARY')
        (self.guide / 'README.md').write_text('ANSWER_CANARY')
        self.gold = self.root / 'selected-gold'
        self.gold.mkdir()
        (self.gold / 'test-service.json').write_text('{"stage":"0"}')
        self.targets = self.root / 'targets'
        self.targets.mkdir()
        self.target = {'case': 'test-service', 'subject': 'synthetic test', 'inputs': {},
                       'given_files': ['evidence'], 'masked_files': ['evidence/audit-note.txt']}
        self.analyst = self.root / 'analyst.py'
        self.analyst.write_text('''import json,re,sys
from pathlib import Path
prompt=sys.stdin.read()
case=Path(re.search(r"EVIDENCE FILES \\(under (\\S+)\\)",prompt)[1])
base=case.parents[1]
files={str(p.relative_to(base)):p.read_text() for p in base.rglob('*') if p.is_file()}
golds=[Path(p) for p in sys.argv[1:]]
print(json.dumps({'stage':'0','gaps':[], 'visible':files, 'gold':[str(p) for g in golds for p in g.glob('*')], 'prompt':prompt}))
''')

    def tearDown(self):
        self.temp.cleanup()

    def run_case(self, extra=(), withhold=True):
        (self.targets / 'test-service.json').write_text(json.dumps(self.target))
        analyst = f'python3 {self.analyst} {self.gold} {ROOT}/evals/attestation/gold {ROOT}/evals/attestation/fixtures/gold'
        cmd = ['python3', str(HARNESS), '--corpus', str(self.corpus), '--targets', str(self.targets),
               '--gold', str(self.gold), '--analyst', analyst, '--out', str(self.root / 'out')]
        if withhold:
            cmd += ['--withhold-root', str(self.guide)]
        return subprocess.run(cmd + list(extra), cwd=ROOT, text=True, capture_output=True)

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is required')
    def test_only_given_evidence_is_visible(self):
        result = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads((self.root / 'out/test-service.json').read_text())
        self.assertEqual(output['visible']['case-studies/test-service/evidence/raw.json'], '{"synthetic":true}')
        self.assertNotIn('README.md', output['visible'])
        self.assertNotIn('case-studies/test-service/report.txt', output['visible'])
        self.assertNotIn('ANSWER_CANARY', json.dumps(output))
        self.assertEqual(output['gold'], [])

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is required')
    def test_inline_prompt_omits_masked_answers(self):
        result = self.run_case(['--inline', '4096'])
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads((self.root / 'out/test-service.json').read_text())
        self.assertIn('raw.json', output['prompt'])
        self.assertIn('Stage 1 requirements', output['prompt'])
        self.assertNotIn('audit-note.txt', output['prompt'])
        self.assertNotIn('ANSWER_CANARY', json.dumps(output))

    def assert_preflight_refusal(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'out').exists(), result.stderr)

    def test_external_corpus_requires_whole_guide_withholding(self):
        self.assert_preflight_refusal(self.run_case(withhold=False))

    def test_missing_evidence_refuses_before_analyst(self):
        self.target['given_files'] = ['absent']
        self.assert_preflight_refusal(self.run_case())

    def test_out_of_case_path_refuses_before_analyst(self):
        self.target['given_files'] = ['../test-service/evidence']
        self.assert_preflight_refusal(self.run_case())

    def test_symlink_out_of_case_refuses_before_analyst(self):
        (self.case / 'evidence/escape').symlink_to(self.guide / 'README.md')
        self.assert_preflight_refusal(self.run_case())

if __name__ == '__main__':
    unittest.main()
