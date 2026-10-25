"""Pure fixtures only: no device IO, mount, cryptsetup or subprocess execution."""
import copy
import json
import unittest
from topology import Refusal, parse_manifest, validate_observations


def fixture():
    manifest = {'schemaVersion':1,'personalizationId':'11111111-1111-4111-8111-111111111111',
        'imageProfileId':'synthetic-mbr-v1','tableType':'dos','diskId':'12345678',
        'logicalSectorBytes':512,'exactDiskSizeBytes':1181696*512,
        'expectedLuksUuid':'22222222-2222-4222-8222-222222222222','partitions':[]}
    for n, (role,start,length) in enumerate((('boot',2048,131072),('root',133120,524288),('vault',657408,524288)),1):
        manifest['partitions'].append({'role':role,'number':n,'type':'0c' if n==1 else '83',
            'start512':start,'length512':length,'partuuid':'12345678-%02d'%n})
    mountinfo = '\n'.join((
        '1 4 8:2 / /run/portable-volatile-lower ro,relatime - ext4 /dev/sda2 ro,noload',
        '2 4 8:1 / /boot/firmware ro,relatime - vfat /dev/sda1 ro',
        '3 4 0:31 / /run/portable-volatile-root rw,nosuid - tmpfs tmpfs rw',
        '4 0 0:32 / / rw,relatime - overlay portable-volatile-root rw,lowerdir=/run/portable-volatile-lower,upperdir=/run/portable-volatile-root/upper,workdir=/run/portable-volatile-root/work'))
    observed={'mountinfo':mountinfo,'parent':{'majorMinor':'8:0','type':'disk','tableType':'dos',
        'diskId':'12345678','logicalSectorBytes':512,'sizeBytes':manifest['exactDiskSizeBytes']},
        'partitions':[], 'sysfs':[], 'vaultProbe':{'majorMinor':'8:3','type':'crypto_LUKS',
        'uuid':manifest['expectedLuksUuid'],'luksVersion':2,'holders':[]},'uuidMatches':['8:3'],'probeErrors':[]}
    for part in manifest['partitions']:
        actual={k:v for k,v in part.items() if k!='role'}
        actual['majorMinor']='8:'+str(part['number'])
        observed['partitions'].append(actual)
        observed['sysfs'].append({k:actual[k] for k in ('majorMinor','number','start512','length512')})
        observed['sysfs'][-1]['parentMajorMinor']='8:0'
    return manifest,observed


class TopologyTests(unittest.TestCase):
    def test_positive_identification_is_not_authentication(self):
        m,o=fixture(); result=validate_observations(parse_manifest(json.dumps(m).encode()),o)
        self.assertEqual(result['state'],'topology-identified')
        self.assertFalse(result['authenticatedMedium'])

    def test_json_syntax_duplicate_unknown_size_and_number_refusals(self):
        m,_=fixture(); raw=json.dumps(m).encode()
        bad=[raw.replace(b'"schemaVersion": 1',b'"schemaVersion": 1, "schemaVersion": 1'),
             raw.replace(b'"number": 1',b'"number": 1, "number": 1'),
             raw.replace(b'"schemaVersion": 1',b'"schemaVersion": true'),
             raw.replace(b'"schemaVersion": 1',b'"schemaVersion": 1.0'),
             raw.replace(b'"schemaVersion": 1',b'"schemaVersion": NaN'),
             b'{"unknown":1}',b'\xff',b'[]',b'null',b' '*16385,
             raw[:-1]+b',"extra":true}',b'['*2000+b']'*2000]
        for value in bad:
            with self.subTest(value=value[:80]),self.assertRaises(Refusal): parse_manifest(value)

    def test_manifest_integer_range_alignment_and_roles(self):
        changes=[('schemaVersion',2),('logicalSectorBytes',4096),('exactDiskSizeBytes',2**100),
            ('exactDiskSizeBytes',False),('diskId','00000000'),('tableType','gpt'),
            ('imageProfileId','../profile'),('expectedLuksUuid','from-worker'),('personalizationId','')]
        for field,value in changes:
            m,_=fixture();m[field]=value
            with self.subTest(field=field),self.assertRaises(Refusal):parse_manifest(json.dumps(m).encode())
        for field,value in [('number',4),('role','root'),('type','05'),('start512',133120),
            ('start512',657409),('length512',2**32),('length512',0),('length512',True),('partuuid','87654321-03')]:
            m,_=fixture();m['partitions'][2][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(Refusal):parse_manifest(json.dumps(m).encode())

    def test_reordered_observation_and_kernel_device_renumbering(self):
        m,o=fixture()
        o['partitions'].reverse();o['sysfs'].reverse()
        # Names/sources are not authority; stable manifest geometry survives device reorder.
        o=json.loads(json.dumps(o).replace('8:','252:').replace('/dev/sda','/dev/vdb'))
        result=validate_observations(m,o)
        self.assertEqual(result['vaultMajorMinor'],'252:3')

    def test_parent_and_kernel_geometry_mismatch(self):
        cases=[]
        for field,value in [('diskId','87654321'),('sizeBytes',999),('type','loop'),('logicalSectorBytes',4096),('tableType','gpt')]:
            m,o=fixture();o['parent'][field]=value;cases.append((m,o))
        for field,value in [('parentMajorMinor','8:16'),('start512',133120),('number',2),('length512',1024)]:
            m,o=fixture();o['sysfs'][2][field]=value;cases.append((m,o))
        m,o=fixture();o['partitions'][1]['partuuid']='87654321-02';cases.append((m,o))
        for m,o in cases:
            with self.subTest(o=o),self.assertRaises(Refusal):validate_observations(m,o)

    def test_duplicate_and_missing_device_records(self):
        for field in ('partitions','sysfs'):
            for mutation in ('duplicate','missing','extra'):
                m,o=fixture()
                if mutation=='duplicate':o[field][2]=copy.deepcopy(o[field][1])
                elif mutation=='missing':o[field].pop()
                else:o[field].append(copy.deepcopy(o[field][2]))
                with self.subTest(field=field,mutation=mutation),self.assertRaises(Refusal):validate_observations(m,o)

    def test_mount_identity_lower_boot_and_overlay_refusals(self):
        replacements=[('1 4 8:2','1 4 8:18'),('2 4 8:1','2 4 8:17'),
            ('ro,noload','ro'),('ro,noload','rw,noload'),
            ('/run/portable-volatile-root/upper','/tmp/upper'),
            ('- tmpfs tmpfs','- ext4 /dev/vdc'),('ro,relatime - vfat','rw,relatime - vfat'),
            ('lowerdir=/run/portable-volatile-lower','lowerdir=/other'),
            ('1 4 8:2 / ','1 4 8:2 /subdir ')]
        for before,after in replacements:
            m,o=fixture();o['mountinfo']=o['mountinfo'].replace(before,after)
            with self.subTest(before=before),self.assertRaises(Refusal):validate_observations(m,o)
        m,o=fixture();o['mountinfo']+='\n'+o['mountinfo'].splitlines()[0]
        with self.assertRaises(Refusal):validate_observations(m,o)
        m,o=fixture();o['mountinfo']+='\n5 0 8:3 / /elsewhere rw - ext4 /dev/sda3 rw'
        with self.assertRaises(Refusal):validate_observations(m,o)

    def test_mount_shadowing_below_lower_or_upper_refused(self):
        for target in ('/run/portable-volatile-lower/opt','/run/portable-volatile-root/upper'):
            m,o=fixture()
            o['mountinfo']+='\n5 0 0:55 / '+target+' rw - tmpfs tmpfs rw'
            with self.subTest(target=target),self.assertRaises(Refusal):validate_observations(m,o)

    def test_boot_ro_bind_of_rw_filesystem_is_refused(self):
        for super_options in ('rw','ro,rw','rw,ro'):
            m,o=fixture()
            o['mountinfo']=o['mountinfo'].replace('- vfat /dev/sda1 ro','- vfat /dev/sda1 '+super_options)
            with self.subTest(super_options=super_options),self.assertRaises(Refusal):validate_observations(m,o)

    def test_normal_run_and_boot_ancestor_mounts_and_order_are_allowed(self):
        m,o=fixture()
        o['mountinfo']=o['mountinfo'].replace('1 4 8:2','1 5 8:2').replace('3 4 0:31','3 5 0:31').replace('2 4 8:1','2 6 8:1')
        o['mountinfo']+='\n5 4 0:40 / /run rw - tmpfs tmpfs rw\n6 4 0:41 / /boot ro - tmpfs tmpfs ro'
        o['mountinfo']='\n'.join(reversed(o['mountinfo'].splitlines()))
        self.assertEqual(validate_observations(m,o)['state'],'topology-identified')

    def test_stacked_or_disconnected_ancestor_mounts_are_refused(self):
        for point in ('/run','/boot'):
            m,o=fixture()
            # New visible ancestor covers old child mounts attached to root.
            o['mountinfo']+='\n5 4 0:40 / '+point+' rw - tmpfs tmpfs rw'
            with self.subTest(point=point,case='disconnected'),self.assertRaises(Refusal):validate_observations(m,o)
            # Even correctly attached children cannot disambiguate stacked records.
            if point=='/run':o['mountinfo']=o['mountinfo'].replace('1 4 8:2','1 5 8:2').replace('3 4 0:31','3 5 0:31')
            else:o['mountinfo']=o['mountinfo'].replace('2 4 8:1','2 5 8:1')
            o['mountinfo']+='\n6 4 0:41 / '+point+' rw - tmpfs tmpfs rw'
            with self.subTest(point=point,case='stacked'),self.assertRaises(Refusal):validate_observations(m,o)

    def test_probe_errors_ambiguous_uuid_and_holders(self):
        mutations=[('probeErrors',['blkid failed']),('uuidMatches',[]),('uuidMatches',['8:3','8:19']),
            ('uuidMatches',['8:19']),('uuidMatches',['8:3','8:3'])]
        for field,value in mutations:
            m,o=fixture();o[field]=value
            with self.subTest(field=field,value=value),self.assertRaises(Refusal):validate_observations(m,o)
        for field,value in [('majorMinor','8:19'),('type','ext4'),('uuid','wrong'),('luksVersion',1),('luksVersion',True),('holders',['253:0'])]:
            m,o=fixture();o['vaultProbe'][field]=value
            with self.subTest(field=field),self.assertRaises(Refusal):validate_observations(m,o)

    def test_exact_clone_is_not_cryptographically_distinguished(self):
        m,o=fixture()
        self.assertEqual(validate_observations(m,o),validate_observations(copy.deepcopy(m),copy.deepcopy(o)))
        self.assertFalse(validate_observations(m,o)['authenticatedMedium'])

    def test_worker_profile_or_unknown_observation_fields_refused(self):
        m,o=fixture();o['workerSuppliedProfile']={}
        with self.assertRaises(Refusal):validate_observations(m,o)


if __name__=='__main__':unittest.main()
