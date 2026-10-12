// Ordinary user-owned files hold credit and original recovery keys, never conversations.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const fail = () => Object.assign(new Error("Saved credit file is unavailable or unsafe; no credit was replaced."), { code: "credit_store_refused" });
export const creditId = (coupon) => crypto.createHash("sha256").update(coupon).digest("hex");
const idOk = (id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
const { O_RDONLY, O_RDWR, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const safeFile = (st) => st.isFile() && st.uid === process.getuid() && (st.mode & 0o777) === 0o600 && st.nlink === 1;

// Creates missing components 0700 one at a time; never follows a symlink or chmods an existing directory.
export function privateDirectory(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw fail();
  let current = path.parse(dir).root;
  for (const part of path.resolve(dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw fail(); }
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw fail();
  }
  const st = fs.lstatSync(dir);
  if (st.uid !== process.getuid() || (st.mode & 0o077)) throw fail();
}

export function readPrivate(file, limit = 1048576) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!safeFile(st) || st.size < 1 || st.size > limit) throw fail();
    const bytes = Buffer.alloc(limit + 1), n = fs.readSync(fd, bytes, 0, limit + 1, 0);
    if (n !== st.size) throw fail();
    return bytes.subarray(0, n);
  } catch { throw fail(); } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function creditStore(directory) {
  privateDirectory(directory);
  const file = (id) => { if (!idOk(id)) throw fail(); return path.join(directory, `${id}.json`); };
  const syncDir = () => { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  return {
    read(id) {
      const value = JSON.parse(readPrivate(file(id)).toString());
      if (value.version !== 1 || value.id !== id || !["offered", "claiming", "uncertain", "installed", "reconciliation_required"].includes(value.state)) throw fail();
      return value;
    },
    exists(id) { return !!fs.lstatSync(file(id), { throwIfNoEntry: false }); },
    list() { return fs.readdirSync(directory).filter(n => /^[0-9a-f]{64}\.json$/.test(n)).map(n => n.slice(0, -5)); },
    write(record, { create = false } = {}) {
      const target = file(record.id), temp = `${target}.${crypto.randomBytes(16).toString("hex")}.tmp`;
      const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > 1048576) throw fail();
      let fd;
      try {
        fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        if (create) { fs.linkSync(temp, target); fs.unlinkSync(temp); }
        else { readPrivate(target); fs.renameSync(temp, target); }
        syncDir();
      } catch { throw fail(); } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    },
    // Kernel flock on this process's open file description: a crash releases it, nothing is stolen
    // and the lock file is never unlinked. flock(1) acquires on the inherited descriptor and exits.
    lock(id) {
      const busy = () => Object.assign(new Error("This credit is already in use by another abalone process."), { code: "credit_locked" });
      let fd;
      try {
        fd = fs.openSync(`${file(id)}.lock`, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
        if (!safeFile(fs.fstatSync(fd))) throw fail();
      } catch { if (fd !== undefined) fs.closeSync(fd); throw fail(); }
      const r = spawnSync("flock", ["-n", "-x", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 10000 });
      if (r.status !== 0) { fs.closeSync(fd); throw r.status === 1 ? busy() : fail(); }
      let held = true;
      return () => { if (held) { held = false; fs.closeSync(fd); } };
    },
  };
}

export function couponInput(text) {
  const refused = () => Object.assign(new Error("Use the gift code or the exact redeem link through stdin/a private file; nothing was claimed."), { code: "coupon_input_refused" });
  if (typeof text !== "string" || text.length > 2048) throw refused();
  let coupon = text.trim();
  if (coupon.startsWith("https://")) {
    let u; try { u = new URL(coupon); } catch { throw refused(); }
    if (u.origin !== "https://amiller.github.io" || !["/abalone/redeem", "/abalone/redeem/"].includes(u.pathname) || coupon.includes("?") || u.username || u.password
        || !/^#code=[A-Za-z0-9_-]{43}$/.test(u.hash)) throw refused();
    coupon = u.hash.slice(6);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(coupon)) throw refused();
  return coupon;
}
