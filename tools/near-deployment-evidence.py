#!/usr/bin/env python3
"""Collect exact NEAR attestation JSON and inspect manager action bindings.

Read-only: no chat requests, policy changes, or private-work admission. Digest
and claimed report-data checks are not Intel quote verification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import urllib.parse
import urllib.request

MAX_BYTES = 8 * 1024 * 1024


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


DECODER = json.JSONDecoder(object_pairs_hook=unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def skip_space(text, start):
    while start < len(text) and text[start] in ' \t\r\n':
        start += 1
    return start


def raw_path(text, route, start=0):
    """Return an exact value slice at an object/array path; full JSON validated first."""
    start = skip_space(text, start)
    if not route:
        _, end = DECODER.raw_decode(text, start)
        return text[start:end]
    target, *rest = route
    if text[start] == '{' and isinstance(target, str):
        pos = skip_space(text, start + 1)
        while text[pos] != '}':
            key, pos = DECODER.raw_decode(text, pos)
            pos = skip_space(text, pos)
            if text[pos] != ':':
                raise ValueError('invalid object')
            pos = skip_space(text, pos + 1)
            if key == target:
                return raw_path(text, rest, pos)
            _, pos = DECODER.raw_decode(text, pos)
            pos = skip_space(text, pos)
            if text[pos] == ',':
                pos = skip_space(text, pos + 1)
    elif text[start] == '[' and isinstance(target, int):
        pos, index = skip_space(text, start + 1), 0
        while text[pos] != ']':
            if index == target:
                return raw_path(text, rest, pos)
            _, pos = DECODER.raw_decode(text, pos)
            pos = skip_space(text, pos)
            if text[pos] == ',':
                pos = skip_space(text, pos + 1)
            index += 1
    raise ValueError('missing raw JSON path')


def canonical_actions(actions):
    allowed = {'timestamp', 'action', 'tag', 'commit', 'file', 'file_sha256', 'services', 'container', 'image'}
    normalized = []
    for action in actions:
        if not isinstance(action, dict) or not {'timestamp', 'action'} <= action.keys() or action.keys() - allowed:
            raise ValueError('unsupported action schema')
        item = {}
        for key, value in action.items():
            if key == 'services':
                if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
                    raise ValueError('unsupported action value')
                if value:
                    item[key] = value
            elif isinstance(value, str):
                item[key] = value
            elif value is not None or key in {'timestamp', 'action'}:
                raise ValueError('unsupported action value')
        normalized.append(item)
    return json.dumps(normalized, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def inspect(raw, nonce, encoding='canonical-string-v1'):
    if encoding not in {'exact', 'canonical-string-v1'} or len(raw) > MAX_BYTES or not isinstance(nonce, str) or not re.fullmatch('[0-9a-f]{64}', nonce):
        raise ValueError('invalid bounds or nonce')
    text = raw.decode('utf-8', errors='strict')
    report = DECODER.decode(text)
    if report['gateway_attestation']['request_nonce'] != nonce:
        raise ValueError('gateway nonce mismatch')
    models = report['model_attestations']
    if not isinstance(models, list) or not models:
        raise ValueError('missing models')
    managers = []
    for i, model in enumerate(models):
        if model['request_nonce'] != nonce:
            raise ValueError('model nonce mismatch')
        cm = model.get('compose_manager_attestation')
        if not isinstance(cm, dict):
            raise ValueError('missing compose-manager evidence')
        actions = cm['actions']
        if not isinstance(actions, list):
            raise ValueError('invalid actions')
        exact = raw_path(text, ['model_attestations', i, 'compose_manager_attestation', 'actions'])
        encoded = exact if encoding == 'exact' else canonical_actions(actions)
        digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
        if cm['actions_hash'] != digest:
            raise ValueError('action digest mismatch')
        if cm['nonce'] != nonce or cm['nonce_source'] != 'client':
            raise ValueError('manager nonce mismatch')
        if cm['report_data'].lower() != digest + nonce:
            raise ValueError('claimed report-data mismatch')
        managers.append({'model_index': i, 'actions_sha256': digest, 'action_encoding': encoding,
                         'action_count': len(actions), 'nonce_matches': True,
                         'claimed_report_data_matches': True,
                         'quote_verified': False, 'deployment_source_closed': False})
    return {'raw_sha256': hashlib.sha256(raw).hexdigest(), 'nonce': nonce,
            'managers': managers, 'private_work_enabled': False}


def save_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path)
    parser.add_argument('--nonce')
    parser.add_argument('--action-encoding', choices=['exact', 'canonical-string-v1'], default='canonical-string-v1')
    parser.add_argument('--model')
    parser.add_argument('--configured-key', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    if args.inspect_only:
        if not args.raw or not args.nonce or args.out or args.model or args.configured_key:
            parser.error('--inspect-only requires --raw and --nonce only')
        with args.raw.open('rb') as source:
            result = inspect(source.read(MAX_BYTES + 1), args.nonce, args.action_encoding)
        print(json.dumps(result))
        return
    if not args.out:
        parser.error('--out is required for capture or saved inspection')
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    if args.raw:
        if not args.nonce or args.model or args.configured_key:
            parser.error('offline inspection requires --raw and --nonce only')
        with args.raw.open('rb') as source:
            raw, nonce = source.read(MAX_BYTES + 1), args.nonce
    else:
        if not args.model or args.nonce:
            parser.error('capture requires --model; nonce is generated locally')
        key = os.environ.get('NEARAI_API_KEY')
        if not key and args.configured_key:
            records = json.loads((Path.home() / '.abalone/node/keys.json').read_text())
            key = next((k['key'] for k in records.get('keys', [])
                        if k['provider'] == 'nearai' and k['label'] == records.get('active', {}).get('nearai')), None)
        if not key:
            raise ValueError('configured key unavailable')
        nonce = secrets.token_hex(32)
        query = urllib.parse.urlencode({'model': args.model, 'nonce': nonce,
                                       'signing_algo': 'ecdsa', 'include_tls_fingerprint': 'true'})
        request = urllib.request.Request('https://cloud-api.near.ai/v1/attestation/report?' + query,
                                         headers={'Authorization': 'Bearer ' + key})
        # Refuse redirects rather than forwarding a credential to another origin.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *unused, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=45) as response:
            raw = response.read(MAX_BYTES + 1)
        key = None
    save_new(args.out / 'attestation.raw.json', raw)
    save_new(args.out / 'capture.json', (json.dumps({'nonce': nonce, 'model': args.model,
             'no_chat_posts': True, 'raw_sha256': hashlib.sha256(raw).hexdigest()}, indent=2) + '\n').encode())
    result = inspect(raw, nonce, args.action_encoding)
    save_new(args.out / 'manager-bindings.json', (json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps({'manager_count': len(result['managers']), 'action_digests_match': True,
                      'quote_verified': False, 'no_chat_posts': True}))


if __name__ == '__main__':
    main()
