# SPDX-License-Identifier: MIT
import fcntl, importlib.util, os, select, signal, struct, subprocess, termios, time, unittest
from pathlib import Path
P = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('console_status', P/'console-status.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

IP = '2: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0\n3: wlan0    inet 192.168.0.10/24 metric 1024 brd 192.168.0.255 scope global dynamic wlan0\n'
IW = 'Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: demo-network\n\tfreq: 5785\n'


class UI:
    def __init__(self, value, error=None): self.value, self.error = value, error
    def DsmackPublicStatus(self): return View(self.value)
    def AgentClient(self):
        ui = self
        class Client:
            def status(self):
                if ui.error: raise ui.error
                return {}
        return Client()


class View:
    def __init__(self, value): self.value = value
    def observe(self, *a): pass
    def render(self, now): return self.value


class Check:
    def __init__(self): self.calls = 0
    def poll(self, now): self.calls += 1; return 'NL 5.2.69.82'


MOUNTS = ('26 24 8:2 / /run/portable-volatile-lower ro,relatime shared:6 - ext4 /dev/sda2 ro,norecovery\n'
          '30 1 0:25 / / rw,relatime shared:1 - overlay portable-volatile-root rw,lowerdir=/run/portable-volatile-lower\n')
VAULT = '90 36 253:0 / /run/portable-vault rw - ext4 /dev/mapper/vault rw\n'


class Status(unittest.TestCase):
    def test_network(self):
        out = {'ip': IP, 'iw': IW}
        self.assertEqual(m.network(lambda a: out[Path(a[0]).name]), ('demo-network', 'Wi-Fi demo-network 192.168.0.10 · eth0 10.0.2.15'))
        out['iw'] = 'Not connected.\n'
        self.assertEqual(m.network(lambda a: out[Path(a[0]).name]), ('Wi-Fi not connected', 'Wi-Fi not connected 192.168.0.10 · eth0 10.0.2.15'))
        def missing(a):
            if a[0].endswith('iw'): raise RuntimeError('command failed: No such device (-19)')
            return '2: eth0    inet 10.0.2.15/24 scope global eth0\n'
        self.assertEqual(m.network(missing), ('Wi-Fi command failed: No such device (-19)', 'Wi-Fi command failed: No such device (-19) · eth0 10.0.2.15'))

    def test_run_reports_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'nope'): m.run(['/bin/sh', '-c', 'echo nope >&2; exit 3'])

    def test_vault(self):
        self.assertEqual(m.vault(MOUNTS), 'Vault locked')
        self.assertEqual(m.vault(VAULT), 'Vault unlocked')

    def test_system(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            disk = Path(d)/'devices/platform/scb/fd500000.pcie/usb2/2-2/host0/block/sda'
            (disk/'sda2').mkdir(parents=True); (disk/'device').mkdir(); (disk/'device/model').write_text('USB Flash Disk\n')
            (Path(d)/'class').mkdir(); (Path(d)/'class/sda2').symlink_to(disk/'sda2')
            self.assertEqual(m.system(MOUNTS, Path(d)/'class'), 'USB, read-only')
            self.assertEqual(m.system(MOUNTS.replace(' ro,relatime', ' rw,relatime'), Path(d)/'class'), 'USB, SYSTEM WRITABLE')
        self.assertEqual(m.system('30 1 8:2 / / rw - ext4 /dev/sda2 rw\n'), 'System: root is ext4 on /dev/sda2, not a RAM overlay')

    def test_exit_text(self):
        self.assertEqual(m.exit_text(0, '{"IsTor":true,"IP":"5.2.69.82"}', ''), ('5.2.69.82', '5.2.69.82'))
        self.assertEqual(m.exit_text(0, '{"IsTor":false,"IP":"1.2.3.4"}', ''), (None, 'NOT TOR: exit 1.2.3.4'))
        self.assertEqual(m.exit_text(97, '', 'curl: (97) Can\'t complete SOCKS5 connection\n'), (None, 'exit unknown'))
        with self.assertRaises(ValueError): m.exit_text(0, '{"IsTor":true,"IP":"\\u001b[2J"}', '')

    def test_country_matches_exact_address_only(self):
        relays = '{"relays":[{"exit_addresses":["192.76.153.253"],"or_addresses":["192.76.153.2:9001"],"country":"de"},{"or_addresses":["5.2.69.82:443"],"country":"nl"}]}'
        self.assertEqual(m.country_text(0, relays, '', '5.2.69.82'), 'NL 5.2.69.82')
        self.assertEqual(m.country_text(0, relays, '', '5.2.69.8'), '5.2.69.8 (exit not listed in Onionoo)')
        self.assertEqual(m.country_text(28, '', 'curl: (28) timed out', '5.2.69.82'), '5.2.69.82')

    def test_exit_check_runs_both_lookups_through_given_curl_and_rate_limits(self):
        fake = 'case "$1" in *api/ip) echo \'{"IsTor":true,"IP":"5.2.69.82"}\';; *search=5.2.69.82) echo \'{"relays":[{"or_addresses":["5.2.69.82:443"],"country":"nl"}]}\';; *) exit 9;; esac'
        check = m.ExitCheck(['/bin/sh', '-c', fake, 'sh'])
        self.assertEqual(check.poll(0), 'checking exit')
        check.proc.wait(); self.assertEqual(check.poll(1), '5.2.69.82')
        check.proc.wait(); self.assertEqual(check.poll(2), 'NL 5.2.69.82')
        self.assertIsNone(check.proc)
        check.poll(m.EXIT_EVERY); self.assertIsNotNone(check.proc); check.proc.wait()

    def test_failed_exit_check_reads_unknown_and_retries_soon(self):
        check = m.ExitCheck(['/bin/sh', '-c', 'echo "curl: (52) Empty reply from server" >&2; exit 52', 'sh'])
        check.poll(0); check.proc.wait(); self.assertEqual(check.poll(1), 'exit unknown')
        check.poll(m.EXIT_RETRY); self.assertIsNone(check.proc)
        check.poll(1 + m.EXIT_RETRY); self.assertIsNotNone(check.proc); check.proc.wait()

    def test_status_rows(self):
        check = Check()
        rows = lambda ui, mounts=MOUNTS: m.status(ui, check, 0, '✓', network=lambda: ('demo-network', 'Wi-Fi demo-network 192.168.0.10'), mountinfo=lambda: mounts)
        self.assertEqual(rows(UI({'tor': 'Connecting to Tor 45%', 'credit': 'Provider account unknown'}))[0],
                         'Connecting to Tor 45% · Vault locked · Credit unknown')
        self.assertEqual(check.calls, 0)
        self.assertEqual(rows(UI({'tor': 'Tor 100%', 'credit': 'Provider account stale'}))[0], 'Tor ✓ NL 5.2.69.82 · Vault locked · Credit stale')
        line = rows(UI({'tor': 'Tor 100%', 'credit': 'Provider account USD 1.995794788'}), MOUNTS + VAULT)
        self.assertEqual(line[0], 'Tor ✓ NL 5.2.69.82 · Vault unlocked · Credit $2.00')
        self.assertTrue(m.console_rows(*line)[1].endswith(' · Wi-Fi demo-network 192.168.0.10'))
        self.assertTrue(m.bar_line(*line).endswith('Credit $2.00 · ' + line[1] + ' · demo-network'))
        self.assertEqual(rows(UI({'tor': 'Tor 100%', 'credit': 'Provider account USD 0.004'}))[0][-12:], 'Credit $0.00')
        self.assertEqual(rows(UI(None, ConnectionRefusedError(111, 'Connection refused')))[0],
                         'Status service error: ConnectionRefusedError [Errno 111] Connection refused · Vault locked')

    def test_watch_draws_row_one_only_while_shell_owns_terminal(self):
        # The PTY child is the "shell": it runs the loop while it is the foreground group,
        # then hands the terminal to a foreground job and must stop drawing.
        r, w = os.pipe()
        pid, master = os.forkpty()
        if pid == 0:
            os.close(w)
            fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', 33, 120, 0, 0))
            texts = [['first', 'a'], ['first', 'a'], ['second', 'b']]
            def line(now):
                if texts: return texts.pop(0)
                if os.tcgetpgrp(1) == os.getpid():
                    job = os.fork()
                    if job == 0:
                        os.setpgid(0, 0); time.sleep(5); os._exit(0)
                    os.setpgid(job, job); signal.signal(signal.SIGTTOU, signal.SIG_IGN); os.tcsetpgrp(1, job)
                return ['third', 'c']
            m.watch_loop(1, os.getpid(), r, line, every=0)
            os._exit(0)
        os.close(r)
        output = b''; deadline = time.monotonic() + 3.5
        while time.monotonic() < deadline:
            if select.select([master], [], [], .2)[0]: output += os.read(master, 4096)
        os.close(w); os.waitpid(pid, 0); os.close(master)
        self.assertEqual(output.count(b'\0337'), 3)
        self.assertTrue(output.startswith(b'\0337\033[?6l\033[7m\033[1;1Hfirst\033[K\033[2;1Ha\033[K\033[0m\033[?6h\0338'))
        self.assertIn(b'\033[1;1Hsecond\033[K\033[2;1Hb\033[K', output)
        self.assertNotIn(b'third', output)
        self.assertIn(b'\033[K\033[0m\033[?6h\0338', output)

    def test_near_text_comes_only_from_the_admission_record(self):
        import json, tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'status.json'
            self.assertEqual(m.near_text(p), 'NEAR: no admission yet')
            a = {'route': 'direct', 'instance': 'glm-5-3-flash-i0.completions.near.ai', 'firmware': 'up-to-date', 'gpuRevocation': 'not checked', 'advisoryIds': []}
            p.write_text(json.dumps({'state': 'running', 'admission': a}))
            self.assertEqual(m.near_text(p), 'NEAR direct i0: model firmware up to date, GPU revocation not checked')
            p.write_text(json.dumps({'admission': {**a, 'firmware': 'out-of-date', 'gpuRevocation': 'checked'}}))
            self.assertEqual(m.near_text(p), 'NEAR direct i0: model firmware OUT OF DATE, GPU revocation checked')
            for bad in ({**a, 'route': 'gateway'}, {**a, 'firmware': 'fine'}, {**a, 'instance': 'cloud-api.near.ai'}, {**a, 'gpuRevocation': None}):
                p.write_text(json.dumps({'admission': bad})); self.assertEqual(m.near_text(p), 'NEAR: unrecognized admission record')
            p.write_text(json.dumps({'state': 'running'})); self.assertEqual(m.near_text(p), 'NEAR: no admission yet')
            p.write_text('{'); self.assertEqual(m.near_text(p), 'NEAR: admission record unreadable (JSONDecodeError)')
            p.chmod(0)
            if os.geteuid() != 0: self.assertEqual(m.near_text(p), 'NEAR: admission record unreadable (Permission denied)')
        self.assertNotIn('out-of-date firmware allowed', (P/'console-status.py').read_text())

    def test_bashrc_and_unit_wiring(self):
        rc = (P/'operator-home/bashrc').read_text()
        self.assertIn("console-status.py watch $$ </dev/null &", rc)
        self.assertIn("~/desktop", rc)
        out = subprocess.run(['bash', '--noprofile', '--rcfile', str(P/'operator-home/bashrc'), '-ic', 'printf %s "$PS0"; eval "$PROMPT_COMMAND"'],
                             capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'}).stdout
        self.assertIn('\\e7\\e[?6l\\e[r\\e8', out)
        self.assertTrue(out.endswith('\0337\033[3r\033[?6h\0338'))
        unit = (P/'portable-operator-shell.service').read_text()
        self.assertIn('ExecStartPre=/usr/bin/setfont -C /dev/tty1 FullGreek-TerminusBold32x16\n', unit)
        display = (P/'portable-display.service').read_text()
        for line in ('After=portable-operator-shell.service', 'OnSuccess=portable-operator-shell.service', 'OnFailure=portable-operator-shell.service'):
            self.assertIn(line + '\n', display)
        sway = (P/'sway.config').read_text()
        self.assertNotIn('agent-terminal.py', sway)
        self.assertIn('bindsym $mod+a workspace 1:agent, exec $term --hold --app-id=portable-agent $native --agent\n', sway)
        self.assertIn('bindsym $mod+Shift+e exit\n', sway)
        self.assertIn('bindsym $mod+w workspace 3:wallet, exec /opt/portable/bin/dsmack-wallet\n', sway)
        self.assertIn('ReadWritePaths=-/run/portable-vault/ui\n', display)
        self.assertIn('status_command exec /bin/sh $display/key-hints.sh\n', sway[sway.index('id hints'):])
        hints = subprocess.run(['timeout', '1', 'sh', P/'key-hints.sh'], capture_output=True, text=True).stdout
        for binding in ('Super+A agent', 'Super+Enter shell', 'Super+W wallet', 'Super+F fullscreen', 'Super+Shift+Q', 'Super+Shift+E console'):
            self.assertIn(binding, hints)
        self.assertLess(len(hints), 160)
        self.assertIn('status_command /usr/bin/python3 -I $display/console-status.py bar\n', sway)


if __name__ == '__main__':
    unittest.main()
