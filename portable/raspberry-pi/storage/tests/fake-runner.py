#!/usr/bin/env python3
"""fake-runner.py — test-only fake executor for the portable storage suite.

Symlinked under the names: cryptsetup lsblk blkid wipefs mkfs.ext4 findmnt
mount umount fuser id chown mkdir chmod stat. Behavior and state live in the
FAKE_STATE directory (default values make the "happy vault world" scenario).
Every invocation is appended as one JSON line to $FAKE_STATE/log (including
the hex form of stdin for cryptsetup, so tests can prove byte-exact
passphrase transfer). NO host block device, mount or service is ever touched.

Knobs (files under FAKE_STATE, all optional):
  OPEN_RC/OPEN_SLEEP/OPEN_LEAVE, CLOSE_RC, FORMAT_RC, LUKS_UUID, MKFS_RC,
  WIPEFS_RC/WIPEFS_OUT, BLKID_*, FUSER_RC, CHOWN_RC, CHMOD_RC, MKDIR_RC,
  MOUNT_RC/MOUNT_SLEEP, UMOUNT_RC, ACCOUNTS,
  lsblk.uuidmap / lsblk.majmin / lsblk.type / lsblk.size / lsblk.mounts /
  lsblk.tree (NAME,TYPE subtree incl. holders) / lsblk.failcols (columns whose
  probe must FAIL with exit 1 — a probe error is never "empty result"),
  mount ("src fstype opts prop [majmin]"), stat.failpath (a path whose stat
  must FAIL — I/O-error fixture).
"""
import json
import os
import sys
import time

TEST_UUID = "12345678-1234-1234-1234-123456789abc"
MAPPER = "portable-vault"


def state():
    d = os.environ.get("FAKE_STATE")
    if not d:
        sys.stderr.write("fake-runner: FAKE_STATE not set\n")
        sys.exit(99)
    return d


def val(name, default):
    p = os.path.join(state(), name)
    try:
        with open(p) as fh:
            return fh.read().strip()
    except OSError:
        return default


def raw(name, default=""):
    p = os.path.join(state(), name)
    try:
        with open(p) as fh:
            return fh.read()
    except OSError:
        return default


def write(name, content):
    with open(os.path.join(state(), name), "w") as fh:
        fh.write(content)


def remove(name):
    try:
        os.unlink(os.path.join(state(), name))
    except OSError:
        pass


def exists(name):
    return os.path.exists(os.path.join(state(), name))


def log(tool, argv, stdin_hex=None):
    entry = {"tool": tool, "argv": [str(a) for a in argv], "ts": time.time(),
             "pid": os.getpid()}
    if stdin_hex is not None:
        entry["stdin_hex"] = stdin_hex
    with open(os.path.join(state(), "log"), "a") as fh:
        fh.write(json.dumps(entry) + "\n")


def read_stdin_hex():
    data = sys.stdin.buffer.read()
    return data.hex()


def dev_arg(argv):
    for a in reversed(argv):
        if a.startswith("/dev/") or a.startswith("/run/"):
            return a
    return None


# --- tools --------------------------------------------------------------------

def t_id(argv):
    if argv and argv[0] == "-u":
        os.execv("/usr/bin/id", ["id", "-u"])
    accounts = val("ACCOUNTS", "portable-agent portable-ui portable-credit").split()
    name = argv[-1] if argv else ""
    log("id", argv)
    sys.exit(0 if name in accounts else 1)


def t_chown(argv):
    log("chown", argv)
    sys.exit(int(val("CHOWN_RC", "0")))


def t_chmod(argv):
    log("chmod", argv)
    rc = int(val("CHMOD_RC", "0"))
    if rc == 0 and len(argv) >= 2:
        mode, path = argv[0], argv[1]
        try:
            os.chmod(path, int(mode, 8))
        except OSError:
            sys.exit(1)
    sys.exit(rc)


def t_mkdir(argv):
    log("mkdir", argv)
    rc = int(val("MKDIR_RC", "0"))
    if rc == 0:
        parents = "-p" in argv or "--parents" in argv
        mode = 0o777
        paths = []
        i = 0
        while i < len(argv):  # positional parse: options and their values are
            a = argv[i]        # never paths (e.g. the mode after -m)
            if a in ("-p", "--parents"):
                i += 1
                continue
            if a == "-m":
                mode = int(argv[i + 1], 8)
                i += 2
                continue
            if a.startswith("-"):
                i += 1
                continue
            paths.append(a)
            i += 1
        for a in paths:
            try:
                if parents:
                    os.makedirs(a, exist_ok=True)
                else:
                    os.mkdir(a)
                os.chmod(a, mode)
            except OSError:
                sys.exit(1)
    sys.exit(rc)


def t_stat(argv):
    # Passthrough to the REAL stat except for an explicit failpath fixture
    # (I/O-error simulation). Trust checks must keep observing real facts.
    failpath = val("stat.failpath", "")
    if failpath and failpath in argv:
        log("stat", argv)
        sys.stderr.write("fake stat: simulated I/O error\n")
        sys.exit(1)
    real = "/usr/bin/stat" if os.path.exists("/usr/bin/stat") else "/bin/stat"
    os.execv(real, ["stat"] + argv)


def t_fuser(argv):
    log("fuser", argv)
    rc = int(val("FUSER_RC", "1"))
    if rc == 0:
        sys.stdout.write("4242 4243\n")
    sys.exit(rc)


def t_wipefs(argv):
    log("wipefs", argv)
    out = val("WIPEFS_OUT", "")
    if out:
        sys.stdout.write(out + "\n")
    sys.exit(int(val("WIPEFS_RC", "0")))


def t_mkfs(argv):
    log("mkfs.ext4", argv)
    sys.exit(int(val("MKFS_RC", "0")))


def t_blkid(argv):
    log("blkid", argv)
    if "-p" in argv:
        out = raw("BLKID_P_OUT", "")
        if out:
            sys.stdout.write(out)
        sys.exit(int(val("BLKID_P_RC", "2")))
    # -s FIELD -o value DEV
    if "-s" in argv and "-o" in argv:
        field = argv[argv.index("-s") + 1]
        if field == "TYPE":
            v = val("BLKID_TYPE", "crypto_LUKS")
        elif field == "UUID":
            v = val("BLKID_UUID", TEST_UUID)
        else:
            v = ""
        if v:
            sys.stdout.write(v + "\n")
            sys.exit(0)
        sys.exit(2)
    sys.exit(2)


def t_lsblk(argv):
    log("lsblk", argv)
    joined = " ".join(argv)
    # lsblk.failcols: columns whose probe must FAIL (probe-error fixture;
    # a probe error must be a refusal, never an "empty result")
    for col in raw("lsblk.failcols", "").split():
        if col in joined:
            sys.stderr.write(f"fake lsblk: simulated probe failure for {col}\n")
            sys.exit(1)
    dev = dev_arg(argv)
    if "KNAME,NAME" in joined:
        default = "fake-va fake-va\n"
        if exists("mapping"):
            default += f"dm-0 {MAPPER}\n"
        sys.stdout.write(raw("lsblk.inventory", default))
        sys.exit(0)
    if "PATH,UUID" in joined:
        sys.stdout.write(raw("lsblk.uuidmap", f"/dev/fake-va {TEST_UUID}\n"))
        sys.exit(0)
    if "MAJ:MIN" in joined:
        table = {}
        for line in raw("lsblk.majmin", "/dev/fake-va 254:0\n/dev/fake-vb 254:16\n"
                                        f"/dev/mapper/{MAPPER} 253:0\n").splitlines():
            parts = line.split()
            if len(parts) == 2:
                table[parts[0]] = parts[1]
        sys.stdout.write((table.get(dev, "") + "\n") if dev else "\n")
        sys.exit(0)
    if "NAME,TYPE" in joined:
        # whole-disk subtree: the disk plus any partitions/holders below it
        sys.stdout.write(raw("lsblk.tree", "fake-va disk\n"))
        sys.exit(0)
    if "MOUNTPOINT" in joined:
        sys.stdout.write(raw("lsblk.mounts", ""))
        sys.exit(0)
    if "TYPE" in joined:
        sys.stdout.write(val("lsblk.type", "disk") + "\n")
        sys.exit(0)
    if "SIZE" in joined:
        sys.stdout.write(val("lsblk.size", "104857600") + "\n")
        sys.exit(0)
    sys.exit(0)


def t_cryptsetup(argv):
    # argv here is sys.argv[1:], so the subcommand is argv[0]
    sub = argv[0] if argv else ""
    if sub == "status":
        log("cryptsetup", argv)
        if exists("STATUS_RC"):
            sys.stderr.write("synthetic cryptsetup status failure\n")
            sys.exit(int(val("STATUS_RC", "1")))
        if exists("mapping"):
            backing = raw("mapping", "").strip()
            sys.stdout.write(
                f"/dev/mapper/{MAPPER} is active.\n"
                f"  type:    LUKS2\n"
                f"  device:  {backing}\n")
            sys.exit(0)
        sys.stderr.write(f"Device {MAPPER} is not active\n")
        sys.exit(4)
    if sub == "open":
        hexin = read_stdin_hex()
        log("cryptsetup", argv, stdin_hex=hexin)
        sleep = val("OPEN_SLEEP", "")
        if sleep:
            time.sleep(float(sleep))
        rc = int(val("OPEN_RC", "0"))
        src = argv[-2]
        leave = val("OPEN_LEAVE", "none")
        if rc == 0:
            write("mapping", src + "\n")
        elif leave == "own":
            write("mapping", src + "\n")
        elif leave == "foreign":
            write("mapping", "/dev/fake-vb\n")
        sys.exit(rc)
    if sub == "close":
        log("cryptsetup", argv)
        rc = int(val("CLOSE_RC", "0"))
        if rc == 0:
            remove("mapping")
        sys.exit(rc)
    if sub == "luksFormat":
        hexin = read_stdin_hex()
        log("cryptsetup", argv, stdin_hex=hexin)
        sys.exit(int(val("FORMAT_RC", "0")))
    if sub == "luksUUID":
        log("cryptsetup", argv)
        sys.stdout.write(val("LUKS_UUID", TEST_UUID) + "\n")
        sys.exit(0)
    sys.stderr.write(f"fake cryptsetup: unhandled subcommand {sub}\n")
    sys.exit(42)


def t_findmnt(argv):
    log("findmnt", argv)
    joined = " ".join(argv)
    target = dev_arg(argv)
    # findmnt -rn -S <source>: one line when that source is mounted
    if "-S" in argv:
        src = argv[argv.index("-S") + 1]
        if exists("mount"):
            src0, fstype0, opts0, _prop, _mm = mount_fields()
            if src0 == src:
                sys.stdout.write(f"{src0} {target or ''} {fstype0} {opts0}\n")
                sys.exit(0)
        sys.exit(1)
    if not exists("mount"):
        sys.exit(1)
    if "-o" in argv:
        cols = argv[argv.index("-o") + 1].split(",")
        out = []
        src0, fstype0, opts0, prop0, majmin0 = mount_fields()
        for c in cols:
            c = c.strip()
            if c == "SOURCE":
                out.append(src0)
            elif c == "TARGET":
                out.append(target or "")
            elif c == "FSTYPE":
                out.append(fstype0)
            elif c == "OPTIONS":
                out.append(opts0)
            elif c == "PROPAGATION":
                out.append(prop0)
            elif c == "MAJ:MIN":
                out.append(majmin0)
        sys.stdout.write(" ".join(out) + "\n")
        sys.exit(0)
    # verbose form: TARGET SOURCE FSTYPE OPTIONS
    src0, fstype0, opts0, _prop, _mm = mount_fields()
    sys.stdout.write(f"{target or ''} {src0} {fstype0} {opts0}\n")
    sys.exit(0)


def mount_fields():
    parts = raw("mount", "").strip().split()
    while len(parts) < 4:
        parts.append("")
    # optional 5th field: the mounted device identity (major:minor); default
    # matches the mapper node (253:0) so the happy path verifies by IDENTITY.
    if len(parts) < 5 or not parts[4]:
        parts.append("253:0")
    return parts[0], parts[1], parts[2], parts[3], parts[4]


def t_mount(argv):
    log("mount", argv)
    rc = int(val("MOUNT_RC", "0"))
    sleep = val("MOUNT_SLEEP", "")
    if sleep:
        time.sleep(float(sleep))
    if rc == 0:
        src = None
        fstype = "ext4"
        opts = "nodev,nosuid,noexec"
        mp = None
        i = 0
        while i < len(argv):
            if argv[i] == "-t":
                fstype = argv[i + 1]; i += 2; continue
            if argv[i] == "-o":
                opts = argv[i + 1]; i += 2; continue
            if argv[i].startswith("/") and src is None:
                src = argv[i]
            elif argv[i].startswith("/"):
                mp = argv[i]
            i += 1
        majmin = val("mount.majmin", "253:0")
        write("mount", f"{src} {fstype} {opts} shared {majmin}\n")
    sys.exit(rc)


def t_umount(argv):
    log("umount", argv)
    rc = int(val("UMOUNT_RC", "0"))
    if rc == 0:
        remove("mount")
    sys.exit(rc)


TOOLS = {
    "id": t_id, "chown": t_chown, "chmod": t_chmod, "mkdir": t_mkdir,
    "stat": t_stat, "fuser": t_fuser, "wipefs": t_wipefs,
    "mkfs.ext4": t_mkfs, "blkid": t_blkid, "lsblk": t_lsblk,
    "cryptsetup": t_cryptsetup, "findmnt": t_findmnt, "mount": t_mount,
    "umount": t_umount,
}

if __name__ == "__main__":
    name = os.path.basename(sys.argv[0])
    fn = TOOLS.get(name)
    if fn is None:
        sys.stderr.write(f"fake-runner: unknown tool name {name}\n")
        sys.exit(99)
    fn(sys.argv[1:])
