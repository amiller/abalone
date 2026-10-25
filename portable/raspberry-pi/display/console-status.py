#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Live status: rows 1-2 of the root operator console, or the Sway bar. Runs as UID971."""
import importlib.util, ipaddress, json, os, re, select, subprocess, sys, time
from decimal import Decimal
from pathlib import Path
BASE = Path(__file__).resolve().parent
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
TOR_CURL = ['/usr/bin/curl', '-sS', '--max-time', '30', '--socks5-hostname', '127.0.0.1:9050']
CHECK_URL = 'https://check.torproject.org/api/ip'
RELAY_URL = 'https://onionoo.torproject.org/details?fields=country,exit_addresses,or_addresses&search='
EXIT_EVERY = 300
EXIT_RETRY = 20
ROWS = 2
# Written by the NEAR inference service after each admission (portable/inference/teep-capture.mjs).
ADMISSION = Path('/run/portable-inference/attestation/latest/status.json')
SEP = ' · '


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BASE/(name+'.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module


def printable(text):
    return re.sub(r'[^\x20-\x7e]', '?', text)[:80]


def run(argv):
    done = subprocess.run(argv, capture_output=True, text=True, timeout=3, env=ENV)
    if done.returncode: raise RuntimeError((done.stderr.strip() or f'exit {done.returncode}').splitlines()[-1])
    return done.stdout


def network(run=run):
    """(Wi-Fi name, full text with addresses)."""
    addresses = {}
    for line in run(['/usr/bin/ip', '-4', '-o', 'addr', 'show', 'scope', 'global']).splitlines():
        fields = line.split(); addresses.setdefault(fields[1], fields[3].split('/')[0])
    try:
        ssid = re.search(r'^\s*SSID: (.*)$', run(['/usr/sbin/iw', 'dev', 'wlan0', 'link']), re.M)
        wifi = 'Wi-Fi ' + (printable(ssid[1]) if ssid else 'not connected')
        name = printable(ssid[1]) if ssid else wifi
    except RuntimeError as error:
        name = wifi = 'Wi-Fi ' + printable(str(error))
    parts = [' '.join(filter(None, (wifi, addresses.pop('wlan0', None))))]
    return name, SEP.join(parts + [f'{iface} {address}' for iface, address in addresses.items()])


def vault(mountinfo):
    return 'Vault unlocked' if '/run/portable-vault' in (line.split()[4] for line in mountinfo.splitlines()) else 'Vault locked'


def system(mountinfo, block=Path('/sys/class/block')):
    mounts = {}
    for line in mountinfo.splitlines():
        fields = line.split(); tail = fields.index('-')
        mounts[fields[4]] = (fields[tail+1], fields[tail+2], fields[5].split(','))
    if mounts['/'][0] != 'overlay': return 'System: root is %s on %s, not a RAM overlay' % mounts['/'][:2]
    _, source, options = mounts['/run/portable-volatile-lower']
    medium = 'USB' if '/usb' in str((block/Path(source).name).resolve()) else 'disk'
    return medium + (', read-only' if 'ro' in options else ', SYSTEM WRITABLE')


def exit_text(code, out, err):
    """(Tor exit address or None, text)."""
    if code: return None, 'exit unknown'
    data = json.loads(out); address = str(ipaddress.ip_address(data['IP']))
    return (address, address) if data['IsTor'] is True else (None, 'NOT TOR: exit ' + address)


def country_text(code, out, err, address):
    if code: return address
    codes = {relay['country'].upper() for relay in json.loads(out)['relays']
             if address in relay.get('exit_addresses', []) or any(a.rsplit(':', 1)[0] == address for a in relay['or_addresses'])}
    return printable('/'.join(sorted(codes))) + ' ' + address if codes else address + ' (exit not listed in Onionoo)'


class ExitCheck:
    """check.torproject.org, then the exit's country from Onionoo, both through Tor; every EXIT_EVERY seconds."""
    def __init__(self, curl=TOR_CURL):
        self.curl, self.proc, self.address, self.text, self.due = curl, None, None, 'checking exit', 0
    def start(self, url):
        self.proc = subprocess.Popen(self.curl + [url], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
    def poll(self, now):
        if self.proc and self.proc.poll() is not None:
            out, err = self.proc.communicate(); code, self.proc = self.proc.returncode, None
            if self.address:
                self.text = country_text(code, out, err, self.address); self.address = None
            else:
                self.address, self.text = exit_text(code, out, err)
                if self.address: self.start(RELAY_URL + self.address)
                elif code: self.due = now + EXIT_RETRY
        if not self.proc and now >= self.due:
            self.start(CHECK_URL); self.due = now + EXIT_EVERY
        return self.text


def workspace(ui):
    view = ui.DsmackPublicStatus(); start = time.monotonic()
    value = ui.AgentClient().status(); view.observe(value, start, time.monotonic())
    result = view.render(time.monotonic()); return result['tor'], result['credit']


def near_text(path=ADMISSION):
    """What the latest NEAR admission recorded, in the pi footer's words; nothing is claimed without it."""
    try: a = json.loads(path.read_text()).get('admission')
    except FileNotFoundError: return 'NEAR: no admission yet'
    except Exception as error: return 'NEAR: admission record unreadable (' + printable(getattr(error, 'strerror', None) or type(error).__name__) + ')'
    if not a: return 'NEAR: no admission yet'
    instance = re.fullmatch(r'[a-z0-9-]+-(i[0-9]+)\.completions\.near\.ai', str(a.get('instance')))
    firmware = {'up-to-date': 'model firmware up to date', 'out-of-date': 'model firmware OUT OF DATE'}.get(a.get('firmware'))
    gpu = {'checked': 'GPU revocation checked', 'not checked': 'GPU revocation not checked'}.get(a.get('gpuRevocation'))
    if a.get('route') != 'direct' or not instance or not firmware or not gpu: return 'NEAR: unrecognized admission record'
    return f'NEAR direct {instance[1]}: {firmware}, {gpu}'


def credit_text(text):
    usd = re.fullmatch(r'Provider account USD (\S+)', text)
    return f'Credit ${Decimal(usd[1]):.2f}' if usd else text.replace('Provider account', 'Credit')


def status(ui, check, now, tick, network=network, mountinfo=lambda: Path('/proc/self/mountinfo').read_text()):
    """(Tor · vault · credit, boot medium, (Wi-Fi name, network text)); tick is the console's or the bar's check mark."""
    try:
        tor, credit = workspace(ui)
        credit = credit_text(credit)
        if tor == 'Tor 100%': tor = f'Tor {tick} ' + check.poll(now)
    except Exception as error:
        tor, credit = 'Status service error: ' + printable(f'{type(error).__name__} {error}'), None
    try: net = network()
    except Exception as error: net = ('Network error: ' + printable(str(error)),) * 2
    mounts = mountinfo()
    try: boot = system(mounts)
    except Exception as error: boot = 'System error: ' + printable(f'{type(error).__name__} {error}')
    return SEP.join(filter(None, (tor, vault(mounts), credit))), boot, net


def console_rows(top, boot, net): return [top, boot + SEP + net[1]]


def bar_line(top, boot, net): return SEP.join((top, boot, net[0]))


def draw(fd, lines):
    columns = os.get_terminal_size(fd).columns
    # Save cursor, leave origin mode to address the top rows, reverse video, back into origin mode, restore.
    rows = ''.join(f'\033[{row};1H' + text[:columns] + '\033[K' for row, text in enumerate(lines, 1))
    os.write(fd, ('\0337\033[?6l\033[7m' + rows + '\033[0m\033[?6h\0338').encode())


def watch_loop(fd, shell, exited, line, every=2):
    text, due, idle = None, 0, False
    while not select.select([exited], [], [], .5)[0]:
        now = time.monotonic(); fresh = None
        if now >= due: fresh, due = line(now), now + every
        was_idle, idle = idle, os.tcgetpgrp(fd) == shell
        # Redraw on each refresh while the shell is idle: clear/reset/full-screen programs erase the rows.
        if idle and (not was_idle or fresh is not None): draw(fd, fresh or text)
        text = fresh or text


def main(args):
    if args[:1] == ['watch'] and len(args) == 2 and os.getresuid() == (0, 0, 0):
        shell = int(args[1]); exited = os.pidfd_open(shell)
        load('home-command').drop(971, [974])
        ui, check = load('agent-terminal'), ExitCheck()
        # The console font (Uni2-Terminus) has no U+2713.
        return watch_loop(1, shell, exited, lambda now: console_rows(*status(ui, check, now, '√')))
    # --near-warning (set by the direct-near image profile) prefixes the recorded NEAR admission.
    if args in (['bar'], ['bar', '--near-warning']) and os.getuid() == 971:
        ui, check = load('agent-terminal'), ExitCheck()
        while True:
            print((near_text() + SEP if len(args) == 2 else '') + bar_line(*status(ui, check, time.monotonic(), '✓')), flush=True); time.sleep(2)
    raise SystemExit('usage: console-status.py watch SHELL_PID (as root) | bar [--near-warning] (as UID971)')


if __name__ == '__main__':
    main(sys.argv[1:])
