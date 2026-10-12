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
  return (await terminalLine(prompt, { hidden })).trim();
}

// One line from the terminal, read by a bash child so this process never consumes stdin that Pi inherits next. Input still
// waiting after the line is discarded, so the rest of a multi-line paste cannot answer a later prompt or reach Pi; `fresh`
// also discards what was typed ahead of the prompt.
export function terminalLine(prompt, { hidden = false, fresh = false } = {}) {
  const drain = "while IFS= read -rs -t 0.05 -n 4096 _; do :; done";
  const script = `${fresh ? `${drain}; ` : ""}IFS= read -r${hidden ? "s" : ""} -p "$1" p || exit 3; ${hidden ? "echo >&2; " : ""}${drain}; printf %s "$p"`;
  const refused = (message) => Object.assign(new Error(message), { code: "credit_input_refused" });
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script, "_", prompt], { stdio: ["inherit", "pipe", "inherit"] });
    const chunks = []; let size = 0;
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024) { child.kill(); return reject(refused("That line is longer than 1024 bytes, so it was refused; run the command again and enter one line.")); }
      chunks.push(chunk);
    });
    child.on("error", () => reject(refused("Reading the terminal needs bash, which could not be started; install bash and run the command again.")));
    child.on("close", (code, signal) => {
      if (code !== 0 || signal) return reject(refused("Terminal input ended before a line was entered; run the command again."));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
