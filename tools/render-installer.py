#!/usr/bin/env python3
"""Render a pinned installer after building the artifact and public trial inputs.

This prepares a file locally. It does not upload, change visibility, or read a gift.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--rev', required=True)
parser.add_argument('--artifact-sha256', required=True)
parser.add_argument('--base', required=True)
parser.add_argument('--trial-dir', type=Path)
parser.add_argument('--template', type=Path, default=Path(__file__).with_name('install.sh.in'))
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
if not re.fullmatch(r'[0-9a-f]{7,40}', args.rev) or not re.fullmatch(r'[0-9a-f]{64}', args.artifact_sha256):
    parser.error('Use a Git revision and exact artifact SHA256.')
base = urlparse(args.base)
if base.scheme != 'https' or not base.hostname or base.username or base.password or base.query or base.fragment or not re.fullmatch(r'https://[A-Za-z0-9./_:-]+', args.base):
    parser.error('Use a credential-free HTTPS release base without query or fragment.')
values = {'REV': args.rev, 'SHA256': args.artifact_sha256, 'BASE': args.base.rstrip('/')}
names = {'TRIAL_SHA256': 'trial.json', 'PIN_SHA256': 'issuer-pin.json', 'APPROVAL_SHA256': 'staging-approval.json', 'READINESS_SHA256': 'readiness.json'}
values.update({key: '' for key in names})
if args.trial_dir:
    public_bytes = {}
    for key, name in names.items():
        item = args.trial_dir / name
        if item.is_symlink() or not item.is_file() or item.stat().st_size > 2 * 1024 * 1024:
            parser.error('Use bounded regular public trial files.')
        with item.open('rb') as stream:
            raw = stream.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            parser.error('Use bounded regular public trial files.')
        public_bytes[name] = raw
        values[key] = hashlib.sha256(raw).hexdigest()
    trial = json.loads(public_bytes['trial.json'])
    if trial.get('issuer', {}).get('pin') != 'issuer-pin.json' or trial.get('issuer', {}).get('approval') != 'staging-approval.json':
        parser.error('The friend bundle must use the exact public sibling filenames.')
text = args.template.read_text()
for key, value in values.items():
    text = text.replace('@' + key + '@', value)
if re.search(r'@[A-Z_0-9]+@', text):
    parser.error('The template contains an unresolved release field.')
args.out.parent.mkdir(parents=True, exist_ok=True)
with args.out.open('x') as output:
    output.write(text)
