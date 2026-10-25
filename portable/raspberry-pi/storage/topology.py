"""Pure, fail-closed single-medium vault identity policy; no IO or authority grant.

Observation dictionaries are an internal contract for a trusted root collector.
They MUST NOT be accepted from a worker, browser, or broker request. This module
is not wired into the existing lifecycle helpers and cannot authenticate media.
"""
import json
import re

MAX_JSON = 16384
MAX_SECTORS = 2**32
LOWER = '/run/portable-volatile-lower'
UPPER = '/run/portable-volatile-root'
BOOT = '/boot/firmware'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
DEV = re.compile(r'(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,9})\Z')


class Refusal(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def keys(value, expected, label):
    require(type(value) is dict and set(value) == set(expected.split()), label+' fields')


def integer(value, low, high, label):
    require(type(value) is int and low <= value <= high, label+' integer bounds')


def text(value, pattern, label):
    require(type(value) is str and pattern.fullmatch(value) is not None, label+' syntax')


def dev(value):
    text(value, DEV, 'device identity')
    major, minor = map(int, value.split(':'))
    require(major <= 4095 and minor <= 1048575, 'device identity range')
    return value


def parse_manifest(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_JSON, 'manifest byte limit')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def bad_number(_):
        raise Refusal('only bounded integer JSON numbers supported')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_float=bad_number, parse_constant=bad_number)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise Refusal('invalid manifest JSON: '+str(error)[:100]) from error
    validate_manifest(value)
    return value


def validate_manifest(value):
    keys(value, 'schemaVersion personalizationId imageProfileId tableType diskId logicalSectorBytes exactDiskSizeBytes partitions expectedLuksUuid', 'manifest')
    integer(value['schemaVersion'], 1, 1, 'schema version')
    text(value['personalizationId'], UUID, 'personalization ID')
    text(value['expectedLuksUuid'], UUID, 'LUKS UUID')
    text(value['imageProfileId'], re.compile(r'[a-z0-9][a-z0-9._-]{0,63}\Z'), 'profile ID')
    require(value['tableType'] == 'dos', 'only DOS/MBR supported')
    text(value['diskId'], re.compile(r'[0-9a-f]{8}\Z'), 'MBR disk ID')
    require(value['diskId'] != '00000000', 'zero disk ID')
    integer(value['logicalSectorBytes'], 512, 512, 'logical sector')
    integer(value['exactDiskSizeBytes'], 512*2048, MAX_SECTORS*512, 'disk size')
    require(value['exactDiskSizeBytes'] % 512 == 0, 'disk size alignment')
    parts = value['partitions']
    require(type(parts) is list and len(parts) == 3, 'exactly three partitions required')
    roles = ('boot', 'root', 'vault')
    last_end = 2048
    for index, part in enumerate(parts, 1):
        keys(part, 'role number type start512 length512 partuuid', 'partition')
        require(part['role'] == roles[index-1], 'partition role ordering')
        integer(part['number'], index, index, 'partition number')
        require(part['type'] == ('0c' if index == 1 else '83'), 'partition type')
        integer(part['start512'], 2048, MAX_SECTORS-1, 'partition start')
        integer(part['length512'], 2048, MAX_SECTORS-1, 'partition length')
        require(part['start512'] % 2048 == part['length512'] % 2048 == 0, 'partition alignment')
        end = part['start512'] + part['length512']
        require(part['start512'] >= last_end, 'partition overlap/order')
        require(end <= value['exactDiskSizeBytes']//512, 'partition exceeds parent')
        require(part['partuuid'] == value['diskId']+'-%02d' % index, 'PARTUUID/disk binding')
        last_end = end
    return value


def mount_records(raw):
    require(type(raw) is str and len(raw) <= 262144, 'mountinfo bounds')
    records = []
    for line in raw.splitlines():
        fields = line.split()
        require(len(fields) >= 10 and fields.count('-') == 1, 'invalid mountinfo')
        split = fields.index('-')
        require(split >= 6 and len(fields) == split+4, 'invalid mountinfo columns')
        require(all(re.fullmatch(r'[0-9]{1,19}', v) for v in fields[:2]), 'mount ID syntax')
        mount_id, parent_id = map(int, fields[:2])
        integer(mount_id, 1, 2**63-1, 'mount ID')
        integer(parent_id, 0, 2**63-1, 'mount parent ID')
        dev(fields[2])
        records.append({'id': mount_id, 'parentId': parent_id, 'device': fields[2], 'root': fields[3], 'point': fields[4],
                        'options': fields[5].split(','), 'type': fields[split+1],
                        'super': fields[split+3].split(',')})
    require(len({item['id'] for item in records}) == len(records), 'duplicate mount ID')
    return records


def visible_ancestors(records, protected):
    # Record order and numeric mount-ID order do not establish visibility.
    # Refuse stacked ancestors; verify each attachment against its nearest
    # observed ancestor mount, including ordinary /run tmpfs and /boot mounts.
    relevant = [item for item in records if any(
        item['point'] == target or item['point'] == '/' or
        target.startswith(item['point'].rstrip('/')+'/') for target in protected)]
    require(len({item['point'] for item in relevant}) == len(relevant),
            'ambiguous stacked ancestor mount')
    for item in relevant:
        if item['point'] == '/':
            continue  # Root parent can lie outside this mount namespace view.
        ancestors = [candidate for candidate in relevant if candidate['point'] != item['point'] and
                     (candidate['point'] == '/' or item['point'].startswith(candidate['point'].rstrip('/')+'/'))]
        require(bool(ancestors), 'missing mount ancestor')
        nearest = max(ancestors, key=lambda candidate: len(candidate['point']))
        require(item['parentId'] == nearest['id'], 'covered or disconnected mount attachment')


def unique_mount(records, point, fs_type):
    candidates = [item for item in records if item['point'] == point]
    require(len(candidates) == 1, 'missing or ambiguous mount: '+point)
    result = candidates[0]
    require(result['type'] == fs_type and result['root'] == '/', 'wrong mount type/root: '+point)
    return result


def options(record, read_only):
    opts = record['options']
    require(len(opts) == len(set(opts)), 'duplicate mount options')
    require(('ro' if read_only else 'rw') in opts, 'mount write policy')
    require(('rw' if read_only else 'ro') not in opts, 'contradictory mount policy')


def validate_observations(manifest, observed):
    """Locked/unheld admission ONLY; not post-open validation or authenticity.

    Active mapper validation requires a separate state-aware trusted collector
    and checked DM backing identity; never rerun this check after opening.
    """
    validate_manifest(manifest)
    keys(observed, 'mountinfo parent partitions sysfs vaultProbe uuidMatches probeErrors', 'observations')
    require(type(observed['probeErrors']) is list and not observed['probeErrors'], 'collector probe failure')
    parent = observed['parent']
    keys(parent, 'majorMinor type tableType diskId logicalSectorBytes sizeBytes', 'parent')
    parent_dev = dev(parent['majorMinor'])
    require(parent['type'] == 'disk', 'unsupported parent device type')
    for actual, expected in (('tableType','tableType'), ('diskId','diskId'),
                             ('logicalSectorBytes','logicalSectorBytes'), ('sizeBytes','exactDiskSizeBytes')):
        require(type(parent[actual]) is type(manifest[expected]) and parent[actual] == manifest[expected], 'parent mismatch: '+actual)
    parts = observed['partitions']
    sysfs = observed['sysfs']
    require(type(parts) is list and len(parts) == 3, 'observed partition count')
    require(type(sysfs) is list and len(sysfs) == 3, 'sysfs partition count')
    by_number = {}
    for part in parts:
        keys(part, 'number type start512 length512 partuuid majorMinor', 'observed partition')
        integer(part['number'],1,3,'observed partition number')
        require(part['number'] not in by_number, 'duplicate partition number')
        dev(part['majorMinor'])
        by_number[part['number']] = part
    require(len({p['majorMinor'] for p in parts}) == 3 and parent_dev not in {p['majorMinor'] for p in parts}, 'duplicate device identity')
    sys_by_dev = {}
    for entry in sysfs:
        keys(entry, 'majorMinor parentMajorMinor number start512 length512', 'sysfs partition')
        dev(entry['majorMinor']); dev(entry['parentMajorMinor'])
        require(entry['majorMinor'] not in sys_by_dev, 'duplicate sysfs identity')
        require(entry['parentMajorMinor'] == parent_dev, 'different parent')
        sys_by_dev[entry['majorMinor']] = entry
    for expected in manifest['partitions']:
        actual = by_number[expected['number']]
        for field in ('number','type','start512','length512','partuuid'):
            require(type(actual[field]) is type(expected[field]) and actual[field] == expected[field], 'partition mismatch: '+field)
        require(actual['majorMinor'] in sys_by_dev, 'missing sysfs partition')
        kernel = sys_by_dev[actual['majorMinor']]
        for field in ('number','start512','length512'):
            require(type(kernel[field]) is type(expected[field]) and kernel[field] == expected[field], 'kernel/table mismatch: '+field)
    records = mount_records(observed['mountinfo'])
    visible_ancestors(records, (LOWER, UPPER, BOOT))
    require(not any(item['point'].startswith((LOWER+'/', UPPER+'/')) for item in records),
            'unexpected mount below immutable lower or volatile backing')
    lower = unique_mount(records, LOWER, 'ext4')
    boot = unique_mount(records, BOOT, 'vfat')
    overlay = unique_mount(records, '/', 'overlay')
    upper = unique_mount(records, UPPER, 'tmpfs')
    options(lower,True); options(boot,True); options(overlay,False); options(upper,False)
    require('ro' in lower['super'] and 'rw' not in lower['super'] and
            ('noload' in lower['super'] or 'norecovery' in lower['super']), 'lower journal/write policy')
    require('ro' in boot['super'] and 'rw' not in boot['super'], 'boot filesystem write policy')
    require(lower['device'] == by_number[2]['majorMinor'], 'lower is not declared root')
    require(boot['device'] == by_number[1]['majorMinor'], 'boot is not declared sibling')
    overlay_values = {}
    for option in overlay['super']:
        if '=' in option:
            key, value = option.split('=',1)
            require(key not in overlay_values, 'duplicate overlay option')
            overlay_values[key] = value
    for key, value in (('lowerdir',LOWER),('upperdir',UPPER+'/upper'),('workdir',UPPER+'/work')):
        require(overlay_values.get(key) == value, 'overlay backing mismatch')
    vault = by_number[3]['majorMinor']
    require(all(item['device'] != vault for item in records), 'vault partition already mounted')
    probe = observed['vaultProbe']
    keys(probe, 'majorMinor type uuid luksVersion holders', 'vault probe')
    require(probe['majorMinor'] == vault, 'probe target mismatch')
    require(probe['type'] == 'crypto_LUKS' and probe['uuid'] == manifest['expectedLuksUuid'], 'LUKS identity mismatch')
    integer(probe['luksVersion'],2,2,'LUKS version')
    require(type(probe['holders']) is list and not probe['holders'], 'vault held by another device')
    matches = observed['uuidMatches']
    require(type(matches) is list and matches == [vault], 'missing or duplicate LUKS UUID')
    return {'state': 'topology-identified', 'parentMajorMinor': parent_dev,
            'vaultMajorMinor': vault, 'expectedLuksUuid': manifest['expectedLuksUuid'],
            'personalizationId': manifest['personalizationId'], 'authenticatedMedium': False}
