// bwrap argv builders. Each sandbox gets its own network namespace with only loopback,
// and resolves names only from a static hosts file (any other DNS lookup fails).
import fs from "node:fs";
import path from "node:path";
import { APPROVALS, CFG, ROOT, STATE, RUNNER_HOME } from "./config.mjs";

const BROWSER = path.join(STATE, "browser"); // lib/browser.mjs PROFILE_DIR

const NSSWITCH = "passwd: files\ngroup: files\nhosts: files\n";

// Static resolver files for a sandbox: admitted names map to loopback (the preload routes them).
export function dnsFiles(dir, hosts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hosts"), ["127.0.0.1 localhost", ...hosts.map((h) => `127.0.0.1 ${h}`)].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "resolv.conf"), "nameserver 127.0.0.1\n");
  fs.writeFileSync(path.join(dir, "nsswitch.conf"), NSSWITCH);
  return ["--ro-bind", path.join(dir, "hosts"), "/etc/hosts", "--ro-bind", path.join(dir, "resolv.conf"), fs.realpathSync("/etc/resolv.conf"),
    "--ro-bind", path.join(dir, "nsswitch.conf"), "/etc/nsswitch.conf"];
}

const base = ["--die-with-parent", "--unshare-all", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
const SYSTEM = ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin"];

// Pi itself sees only /usr (with the /bin and /lib links), CA certificates, passwd and group, the node install, the repo
// (each runner login dir an empty tmpfs: it exists, so "has a login" still reads true, but holds nothing), the state dir (approvals read-only), its run dir and the folder it works in. Nothing else of
// the host exists in its view: no /etc beyond those files, /srv, /var, /opt, /home or /run. The abalone browser
// profile (logins, cookies) under <STATE>/browser is an empty tmpfs here: only the launcher's bridge touches it.
// The trace keys ($STATE/keys) are hidden in every mode. Strict incognito replaces the whole state dir with a tmpfs, so
// every harness write inside the sandbox (logs, notebook, crash and debug logs, scratch) stays in memory; only the
// canary records and approvals are bound in, read-only.
export function piArgv(run, hosts, cwd, { incognito = false, gift = false } = {}) {
  const nodePrefix = path.resolve(process.execPath, "../..");
  fs.mkdirSync(RUNNER_HOME, { recursive: true });
  fs.mkdirSync(APPROVALS, { recursive: true });
  fs.mkdirSync(BROWSER, { recursive: true });
  fs.mkdirSync(path.join(STATE, "keys"), { recursive: true, mode: 0o700 });
  const canaries = path.join(STATE, "canaries");
  // A gift in incognito: its coupon (read only) and its balance file, the one number the session updates.
  const giftFiles = incognito && gift ? ["--ro-bind", path.join(STATE, "coupon.json"), path.join(STATE, "coupon.json"), "--bind", path.join(STATE, "gift-left.json"), path.join(STATE, "gift-left.json")] : [];
  const state = incognito ? ["--tmpfs", STATE, ...(fs.existsSync(canaries) ? ["--ro-bind", canaries, canaries] : []), ...giftFiles]
    : ["--bind", STATE, STATE, "--tmpfs", path.join(STATE, "keys")];
  return [...base, ...SYSTEM, ...["/etc/ssl", "/etc/passwd", "/etc/group"].flatMap((p) => ["--ro-bind", p, p]), ...dnsFiles(path.join(run, "etc"), hosts),
    "--ro-bind", nodePrefix, nodePrefix, "--ro-bind", ROOT, ROOT, "--tmpfs", RUNNER_HOME,
    ...fs.readdirSync(RUNNER_HOME).flatMap((d) => ["--tmpfs", path.join(RUNNER_HOME, d)]), ...state, "--ro-bind", APPROVALS, APPROVALS, "--tmpfs", BROWSER,
    "--ro-bind", CFG, CFG, "--bind", run, run, "--bind", cwd, cwd, "--chdir", cwd];
}

// The bash tool, nested inside the Pi sandbox (so it starts from Pi's view): no network at all, no egress sockets
// or session control socket (the run dir), no state dir (private-out, logs, keys), no runner logins, and a clean environment.
export function bashArgv(cwd) {
  const run = process.env.ABALONE_EGRESS ? ["--tmpfs", process.env.ABALONE_EGRESS] : [];
  const record = path.join(cwd, ".abalone"), ro = fs.existsSync(record) ? ["--ro-bind", record, record] : []; // the trace store: readable ciphertext, not writable
  return ["bwrap", "--ro-bind", "/", "/", ...base, "--tmpfs", STATE, "--tmpfs", RUNNER_HOME, ...run, "--bind", cwd, cwd, ...ro, "--chdir", cwd,
    "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", cwd, "--setenv", "TERM", "dumb", "--"];
}

// An open runner: only system dirs, its own login home, a scratch dir holding the pour, and an
// HTTPS proxy (socat → egress connect.sock) that admits only the vendor's API hosts.
export function runnerArgv({ run, home, scratch, bin, connectSock }) {
  return ["bwrap", ...base, ...SYSTEM, "--ro-bind", "/etc", "/etc", ...dnsFiles(path.join(run, "runner-etc"), []),
    "--bind", home, "/home/runner", "--ro-bind", bin, "/opt/runner/bin", "--bind", scratch, "/work", "--ro-bind", connectSock, "/egress/connect.sock",
    "--chdir", "/work", "--clearenv", "--setenv", "HOME", "/home/runner", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "TERM", "dumb",
    "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128", "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
    "--setenv", "DISABLE_AUTOUPDATER", "1", "--",
    "bash", "-c", 'socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/egress/connect.sock & ' +
      'until (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null; do sleep 0.05; done; exec "$@"', "runner"];
}
