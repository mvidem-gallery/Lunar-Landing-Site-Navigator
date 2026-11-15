import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_BYTES = 256 * 1024 * 1024;
const CACHE_VERSION = 'lunar-api-v1';

export function createLocalCache(directory) {
  const pending = new Map();
  let cleanupTimer;

  async function trim() {
    try {
      const entries = (await Promise.all((await readdir(directory))
        .filter(name => name.endsWith('.cache'))
        .map(async name => {
          const path = join(directory, name);
          try { return {path, ...await stat(path)}; } catch { return null; }
        }))).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (bytes <= MAX_BYTES) break;
        await rm(entry.path, {force: true});
        bytes -= entry.size;
      }
    } catch {}
  }

  async function load(path, maxAge, fetchResponse) {
    try {
      const file = await readFile(path);
      const separator = file.indexOf(10);
      if (separator >= 0) {
        const {savedAt, status, headers} = JSON.parse(file.subarray(0, separator).toString());
        if (Date.now() - savedAt <= maxAge) {
          return {body: file.subarray(separator + 1), status, headers, cache: 'HIT'};
        }
      }
    } catch {}

    const response = await fetchResponse();
    const headers = Object.fromEntries(response.headers);
    const result = {body: Buffer.from(await response.arrayBuffer()), status: response.status, headers, cache: 'MISS'};
    if (response.status === 200 && result.body.length <= MAX_BYTES / 4) {
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(directory, {recursive: true});
        const meta = JSON.stringify({savedAt: Date.now(), status: result.status, headers}) + '\n';
        await writeFile(temporary, Buffer.concat([Buffer.from(meta), result.body]));
        await rename(temporary, path);
        if (!cleanupTimer) {
          cleanupTimer = setTimeout(() => { cleanupTimer = undefined; void trim(); }, 1000);
          cleanupTimer.unref();
        }
      } catch {
        await rm(temporary, {force: true}).catch(() => {});
      }
    }
    return result;
  }

  return async (url, maxAge, fetchResponse) => {
    const query = new URLSearchParams(url.search);
    query.sort();
    const key = createHash('sha256').update(CACHE_VERSION + url.pathname + '?' + query).digest('hex');
    if (!pending.has(key)) {
      const request = load(join(directory, key + '.cache'), maxAge, fetchResponse)
        .finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return pending.get(key);
  };
}
