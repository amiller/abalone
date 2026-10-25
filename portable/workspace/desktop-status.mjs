// Read the public, root-owned desktop projection. No financial authority.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

const unknown = () => ({tor:{state:'unknown',progress:null},credit:{state:'unknown'},validForMs:0});
const directory = '/run/portable-status';

export function projectDesktopSnapshot(data, bootId, now) {
  const result = unknown();
  if (!data || data.version !== 1 || data.boot_id !== bootId ||
      typeof data.observed_boottime !== 'number' || !Number.isFinite(data.observed_boottime) ||
      !Number.isFinite(now) || now - data.observed_boottime < 0 || now - data.observed_boottime > 15) return result;
  const tor = data.tor;
  result.validForMs = Math.floor((15 - (now - data.observed_boottime)) * 1000);
  if (tor?.state === 'stopped' && tor.progress === null) result.tor.state = 'stopped';
  if (Number.isInteger(tor?.progress) && tor.progress >= 0 && tor.progress <= 100 &&
      ((tor.state === 'bootstrapped' && tor.progress === 100) ||
       (tor.state === 'starting' && tor.progress < 100))) result.tor = {state:tor.state,progress:tor.progress};
  // A balance or address in this file is not an admitted financial projection.
  return result;
}

async function boundedRead(file, limit, publicFile = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (publicFile && (info.uid !== 0 || (info.mode & 0o022) || info.size > limit))) throw Error('untrusted projection');
    const buffer = Buffer.alloc(limit + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw Error('projection overflow');
    return buffer.subarray(0,bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export async function readDesktopStatus() {
  try {
    for (const path of ['/run', directory]) {
      const info = await fs.lstat(path);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022)) throw Error('untrusted projection directory');
    }
    const data = JSON.parse(await boundedRead(directory + '/status.json', 1024, true));
    const bootId = (await boundedRead('/proc/sys/kernel/random/boot_id', 64)).trim();
    if (!/^[0-9a-f-]{36}$/.test(bootId)) return unknown();
    const uptime = await boundedRead('/proc/uptime', 128);
    if (!/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*$/.test(uptime)) return unknown();
    return projectDesktopSnapshot(data, bootId, Number(uptime.trim().split(/\s+/)[0]));
  } catch { return unknown(); }
}
