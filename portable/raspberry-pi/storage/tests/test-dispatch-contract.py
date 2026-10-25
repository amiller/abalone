#!/usr/bin/env python3
"""test-dispatch-contract.py — broker dispatch contract against the REAL
helper scripts with injected fake executors.

Runs inside the test namespace as mapped root (the staged tree satisfies the
trust chain). Everything goes through Broker.dispatch — the same code the
socket path uses — so the broker-visible replies for unlock/lock/status are
tested exactly as clients receive them. In particular, a mismatched vault
state (foreign mapper, unrelated/same-string mount, duplicate/absent UUID)
must never be reported as "unlocked".

No sockets, no host devices: helpers run with PATH pointed at the fake
executor dir and a fresh FAKE_STATE directory.
"""
import importlib.util
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location(
    "vault_broker", os.path.join(HERE, "..", "guest", "vault-broker.py"))
vb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vb)

FAILURES = []
PASSES = []


def check(name, cond, detail=""):
    if cond:
        PASSES.append(name)
        print(f"ok   {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


BIN_DIR = os.environ["DISPATCH_BIN_DIR"]
CONF = os.environ["DISPATCH_CONFIG"]
STATE = os.environ["DISPATCH_STATE"]
FAKEBIN = os.environ["DISPATCH_FAKEBIN"]
MOUNTPOINT = "/run/portable-vault"

os.makedirs(STATE, exist_ok=True)


def setf(name, content):
    with open(os.path.join(STATE, name), "w") as fh:
        fh.write(content)


def new_state():
    shutil.rmtree(STATE, ignore_errors=True)
    os.makedirs(STATE, exist_ok=True)
    shutil.rmtree(MOUNTPOINT, ignore_errors=True)


def calls(tool, sub=None):
    n = 0
    try:
        with open(os.path.join(STATE, "log")) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("tool") != tool:
                    continue
                if sub and (not e.get("argv") or e["argv"][0] != sub):
                    continue
                n += 1
    except OSError:
        pass
    return n


MAPPER_MOUNT = "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 253:0\n"
UUID = "12345678-1234-1234-1234-123456789abc"

# Point dispatched helpers at the injected fake executors (module-level
# override, same pattern as SCRIPT_TIMEOUT_S in the unit tests).
vb.HELPER_ENV = {"PATH": FAKEBIN + ":" + os.environ["PATH"],
                 "FAKE_STATE": STATE, "LC_ALL": "C"}
cfg = vb.parse_config(CONF)
broker = vb.Broker(cfg, BIN_DIR, config_path=CONF)

# --- locked baseline -----------------------------------------------------------
new_state()
st, detail = broker.dispatch("status", None)
check("dispatch: locked status is ok with 'state: locked'",
      st == "ok" and "state: locked" in detail, f"{st} {detail}")

# --- foreign backing device (the review's reproduction) --------------------------
new_state()
setf("mapping", "/dev/fake-vb\n")
setf("mount", MAPPER_MOUNT)
st, detail = broker.dispatch("status", None)
check("dispatch: foreign backing device -> error 'state: unsafe', never unlocked",
      st == "error" and "state: unsafe" in detail and "state: unlocked" not in detail,
      f"{st} {detail}")
check("dispatch: status never closed/unmounted anything",
      calls("cryptsetup", "close") == 0 and calls("umount") == 0)

# --- same-string mount on a different kernel device -----------------------------
new_state()
setf("mapping", "/dev/fake-va\n")
setf("mount", "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 259:0\n")
st, detail = broker.dispatch("status", None)
check("dispatch: same-string mount on wrong device -> unsafe (major:minor compared)",
      st == "error" and "state: unsafe" in detail and "state: unlocked" not in detail,
      f"{st} {detail}")

# --- duplicate UUID: identity unverifiable -> partial, never unlocked -----------
new_state()
setf("mapping", "/dev/fake-va\n")
setf("mount", MAPPER_MOUNT)
setf("lsblk.uuidmap", f"/dev/fake-va {UUID}\n/dev/fake-vb {UUID}\n")
st, detail = broker.dispatch("status", None)
check("dispatch: duplicate UUID -> 'state: partial' (identity unverified), never unlocked",
      st == "ok" and "state: partial" in detail and "state: unlocked" not in detail,
      f"{st} {detail}")

# --- absent UUID with nothing active -> locked -----------------------------------
new_state()
setf("lsblk.uuidmap", "\n")
st, detail = broker.dispatch("status", None)
check("dispatch: absent UUID, nothing active -> 'state: locked'",
      st == "ok" and "state: locked" in detail, f"{st} {detail}")

# --- full lifecycle through the actual dispatch contract -------------------------
new_state()
st, detail = broker.dispatch("unlock", b"correct horse battery staple")
check("dispatch: unlock through broker ok with truthful state line",
      st == "ok" and "state: mapping=active mounted=yes" in detail, f"{st} {detail}")
st, detail = broker.dispatch("status", None)
check("dispatch: status after unlock -> 'state: unlocked'",
      st == "ok" and "state: unlocked" in detail, f"{st} {detail}")
st, detail = broker.dispatch("unlock", b"correct horse battery staple")
check("dispatch: second unlock is idempotent ok", st == "ok", f"{st} {detail}")

new_state()
setf("OPEN_RC", "1\n")
st, detail = broker.dispatch("unlock", b"wrong key")
check("dispatch: wrong key -> error with truthful state line",
      st == "error" and "state" in detail and "exit=4" in detail, f"{st} {detail}")

new_state()
st, detail = broker.dispatch("unlock", b"k")
check("dispatch: unlock (for lock) ok", st == "ok", f"{st} {detail}")
st, detail = broker.dispatch("lock", None)
check("dispatch: lock ok", st == "ok", f"{st} {detail}")
st, detail = broker.dispatch("status", None)
check("dispatch: status after lock -> 'state: locked'",
      st == "ok" and "state: locked" in detail, f"{st} {detail}")

print(f"\ndispatch-contract tests: {len(PASSES)} passed, {len(FAILURES)} failed")
sys.exit(1 if FAILURES else 0)
