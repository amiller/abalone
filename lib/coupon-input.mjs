// Keep the issuer transport responsive while the recipient reviews and enters input.
import fs from "node:fs";
import { spawn } from "node:child_process";

export async function couponEntry(envName, prompt, hidden = false) {
  const fd = process.env[envName];
  if (fd !== undefined) {
    if (!/^[0-9]+$/.test(fd)) throw new Error("Invalid coupon input descriptor.");
    const bytes = [], b = Buffer.alloc(1);
    while (bytes.length < 256) {
      const count = await new Promise((resolve, reject) => fs.read(Number(fd), b, 0, 1, null,
        (error, read) => error ? reject(new Error("Coupon input descriptor could not be read.")) : resolve(read)));
      if (!count || b[0] === 10) break;
      bytes.push(b[0]);
    }
    return Buffer.from(bytes).toString("utf8").trim();
  }
  if (!process.stdin.isTTY) throw new Error(`Coupon entry requires your terminal or the dedicated ${envName} descriptor. Never pass a coupon in command arguments.`);
  const script = hidden ? 'IFS= read -rs -p "$1" p; echo >&2; printf %s "$p"' : 'IFS= read -r -p "$1" p; printf %s "$p"';
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script, "_", prompt], { stdio: ["inherit", "pipe", "inherit"] });
    const chunks = []; let size = 0, refused = false;
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024) { refused = true; child.kill(); return; }
      chunks.push(chunk);
    });
    child.on("error", () => reject(new Error("Coupon terminal input could not be started.")));
    child.on("close", (code, signal) => {
      if (refused || code !== 0 || signal) return reject(new Error("Coupon terminal input did not complete."));
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}
