#!/usr/bin/python3
"""Read-only workspace capability: inherited FD3, never caller-selected host roots."""
import json, os, stat, sys
LIMIT = 128 * 1024

def inspect(operation, relative):
    if operation not in ('list', 'read') or not isinstance(relative, str):
        raise ValueError('invalid_request')
    if len(relative.encode('utf-8')) > 2048 or relative.startswith('/') or '\0' in relative:
        raise ValueError('invalid_request')
    parts = [] if relative == '' else relative.split('/')
    if len(parts) > 32 or any(p in ('', '.', '..') or len(p.encode('utf-8')) > 255 for p in parts):
        raise ValueError('invalid_request')
    if operation == 'read' and not parts:
        raise ValueError('invalid_request')
    fd = os.dup(3)
    try:
        for index, part in enumerate(parts):
            directory = operation == 'list' or index < len(parts)-1
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            if directory: flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd); fd = child
        before = os.fstat(fd)
        if operation == 'list':
            entries = []
            with os.scandir(fd) as scan:
                for entry in scan:
                    if len(entries) == 200:
                        return {'path': relative, 'entries': sorted(entries, key=lambda e:e['name']), 'truncated': True}
                    # lstat relative to pinned directory; never traverse a link.
                    try: info = entry.stat(follow_symlinks=False)
                    except FileNotFoundError: continue
                    kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'unsupported'
                    # Undecodable Unix names cannot be round-tripped by this UTF-8 API.
                    try: entry.name.encode('utf-8')
                    except UnicodeError: continue
                    entries.append({'name': entry.name, 'kind': kind, 'bytes': info.st_size if kind == 'file' else None})
            return {'path': relative, 'entries': sorted(entries, key=lambda e:e['name']), 'truncated': False}
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('unsupported')
        if before.st_size > LIMIT: raise ValueError('too_large')
        data = bytearray()
        while len(data) <= LIMIT:
            chunk = os.read(fd, min(16384, LIMIT + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > LIMIT: raise ValueError('too_large')
        after = os.fstat(fd)
        signature = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
        if signature(before) != signature(after) or len(data) != after.st_size:
            raise ValueError('changed')
        try: text = data.decode('utf-8')
        except UnicodeError: raise ValueError('binary')
        if any(ord(c) < 32 and c not in '\n\r\t' for c in text): raise ValueError('binary')
        return {'path': relative, 'text': text, 'bytes': len(data), 'modifiedNs': str(after.st_mtime_ns)}
    finally: os.close(fd)

if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(4097))
        if set(request) != {'operation', 'path'}: raise ValueError('invalid_request')
        result = {'ok': True, **inspect(request['operation'],request['path'])}
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        code = str(error) if isinstance(error,ValueError) else 'unavailable'
        if code not in ('invalid_request','unsupported','too_large','changed','binary'): code = 'unavailable'
        result = {'ok': False, 'code': code}
    print(json.dumps(result, ensure_ascii=True, separators=(',',':')))
