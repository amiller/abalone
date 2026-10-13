// Portable state is beside the runtime, never inside its admitted code tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateDirectory } from "./credit-store.mjs";

function portableContainer(root) {
  const container = path.dirname(root), marker = path.join(container, "portable.json");
  const st = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!st) return null;
  const refuse = () => { throw new Error("Portable client marker is invalid or unsafe; no saved state was opened."); };
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) refuse();
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { refuse(); }
  if (metadata?.kind !== "abalone-portable" || metadata.version !== 1 ||
      !/^[0-9a-f]{7,40}$/.test(metadata.revision) || !/^[0-9a-f]{64}$/.test(metadata.runtimeSha256) ||
      metadata.profile !== "linux-node24-owned-host") refuse();
  return container;
}

export function statePath(root, env = process.env, home = os.homedir()) {
  if (env.ABALONE_DIR !== undefined) return env.ABALONE_DIR;
  const container = portableContainer(root);
  if (!container) return path.join(home, ".abalone");
  const state = path.join(container, "state");
  privateDirectory(state); // 0700; refuses symlinks and unsafe existing ownership/modes.
  return state;
}

export function portableWorkspace(root, cwd) {
  const container = portableContainer(root);
  if (!container || fs.realpathSync(cwd) !== fs.realpathSync(container)) return cwd;
  const workspace = path.join(container, "work");
  privateDirectory(workspace);
  return workspace;
}
