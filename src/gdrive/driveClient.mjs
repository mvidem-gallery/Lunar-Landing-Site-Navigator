import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_MANIFEST_PATH = path.join(PROJECT_ROOT, 'drive-manifest.json');
export const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, 'cache', 'gdrive');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.img': 'application/octet-stream',
  '.bsp': 'application/octet-stream',
  '.bpc': 'application/octet-stream',
  '.pca': 'application/octet-stream',
  '.epa': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.tab': 'text/plain; charset=utf-8',
};

let cachedManifest = null;
let cachedManifestMtimeMs = -1;

const inFlightFiles = new Map();
const inFlightBundles = new Map();
const inFlightBundleIndices = new Map();
const parsedBundleIndices = new Map();

export function getCacheRoot() {
  return process.env.GDRIVE_CACHE_DIR?.trim()
    ? path.resolve(process.env.GDRIVE_CACHE_DIR.trim())
    : DEFAULT_CACHE_DIR;
}

export function getManifestPath() {
  return process.env.GDRIVE_MANIFEST_PATH?.trim()
    ? path.resolve(process.env.GDRIVE_MANIFEST_PATH.trim())
    : DEFAULT_MANIFEST_PATH;
}

export function preferLocalAssets() {
  return process.env.GDRIVE_PREFER_LOCAL === '1';
}

export function loadDriveManifest({ force = false } = {}) {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, folderId: null, files: {}, bundles: {} };
  }
  const stat = fs.statSync(manifestPath);
  if (!force && cachedManifest && stat.mtimeMs === cachedManifestMtimeMs) {
    return cachedManifest;
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  cachedManifest = {
    version: parsed.version || 1,
    folderId: parsed.folderId || null,
    folderUrl: parsed.folderUrl || null,
    generatedAt: parsed.generatedAt || null,
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
    bundles: parsed.bundles && typeof parsed.bundles === 'object' ? parsed.bundles : {},
  };
  cachedManifestMtimeMs = stat.mtimeMs;
  return cachedManifest;
}

export function normalizeLogicalPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function getDriveFileEntry(logicalPath) {
  const manifest = loadDriveManifest();
  const key = normalizeLogicalPath(logicalPath);
  const entry = manifest.files?.[key];
  if (!entry || !entry.fileId) return null;
  return { key, ...entry };
}

export function hasDriveFile(logicalPath) {
  return Boolean(getDriveFileEntry(logicalPath));
}

export function getCachedFilePath(logicalPath) {
  const key = normalizeLogicalPath(logicalPath);
  return path.join(getCacheRoot(), ...key.split('/'));
}

export function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function buildDirectDriveUrl(fileId) {
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  if (apiKey) {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
  }
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
}

function extractDriveConfirmUrl(html, fileId) {
  const actionMatch = /<form[^>]+id="download-form"[^>]+action="([^"]+)"/i.exec(html);
  if (actionMatch) {
    const action = decodeHtmlEntities(actionMatch[1]);
    const params = new URLSearchParams();
    const inputRegex = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
    let m;
    while ((m = inputRegex.exec(html)) !== null) {
      params.set(m[1], decodeHtmlEntities(m[2]));
    }
    if (!params.has('id')) params.set('id', fileId);
    if (!params.has('confirm')) params.set('confirm', 't');
    return `${action}?${params.toString()}`;
  }

  const confirmMatch = /confirm=([0-9A-Za-z_-]+)/i.exec(html);
  const uuidMatch = /uuid=([0-9A-Za-z_-]+)/i.exec(html);
  if (confirmMatch) {
    const extra = uuidMatch ? `&uuid=${encodeURIComponent(uuidMatch[1])}` : '';
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${encodeURIComponent(confirmMatch[1])}${extra}`;
  }
  return null;
}

async function openDriveDownloadResponse(fileId, { rangeHeader = null, timeoutMs = 120_000 } = {}) {
  const headers = {
    'User-Agent': 'NASA-Lunar-Navigator/1.0',
  };
  if (rangeHeader) {
    headers.Range = rangeHeader;
  }

  const primaryUrl = buildDirectDriveUrl(fileId);
  let res = await fetch(primaryUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const ctype = res.headers.get('content-type') || '';
  if (res.ok && ctype.includes('text/html')) {
    const html = await res.text();
    const confirmUrl = extractDriveConfirmUrl(html, fileId);
    if (!confirmUrl) {
      throw new Error(`Google Drive returned an HTML confirmation page for file ${fileId}. Check sharing permissions.`);
    }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    res = await fetch(confirmUrl, {
      headers: {
        ...headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const retryCtype = res.headers.get('content-type') || '';
    if (res.ok && retryCtype.includes('text/html')) {
      await res.body?.cancel();
      throw new Error(`Google Drive blocked automated download for file ${fileId}.`);
    }
  }

  if (!res.ok && res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`Google Drive download failed for ${fileId}: HTTP ${res.status} ${res.statusText}`);
  }

  return res;
}

async function downloadDriveFileToDisk(fileId, targetPath, { expectedSize = null, expectedSha256 = null, label = '' } = {}) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const timeoutMs = expectedSize && expectedSize > 100 * 1024 * 1024 ? 1_800_000 : 180_000;
    const res = await openDriveDownloadResponse(fileId, { timeoutMs });

    const hash = expectedSha256 ? crypto.createHash('sha256') : null;
    let downloaded = 0;
    let lastLog = 0;
    const started = Date.now();

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        downloaded += chunk.length;
        if (hash) hash.update(chunk);
        const now = Date.now();
        if (expectedSize && expectedSize >= 5 * 1024 * 1024 && (now - lastLog > 1500 || downloaded === expectedSize)) {
          const pct = ((downloaded / expectedSize) * 100).toFixed(1);
          const mb = (downloaded / (1024 * 1024)).toFixed(1);
          const tot = (expectedSize / (1024 * 1024)).toFixed(1);
          const mbps = (downloaded / (1024 * 1024) / Math.max(0.2, (now - started) / 1000)).toFixed(1);
          console.log(`[gdrive] ${label || path.basename(targetPath)}: ${pct}% (${mb}/${tot} MB, ${mbps} MB/s)`);
          lastLog = now;
        }
        cb(null, chunk);
      },
    });

    await pipeline(res.body, meter, fs.createWriteStream(tmpPath));

    const stat = await fsp.stat(tmpPath);
    if (expectedSize && stat.size !== expectedSize) {
      throw new Error(`Size mismatch for ${label || targetPath}: expected ${expectedSize}, got ${stat.size}`);
    }
    if (hash && expectedSha256) {
      const actual = hash.digest('hex');
      if (actual !== expectedSha256) {
        throw new Error(`SHA-256 mismatch for ${label || targetPath}: expected ${expectedSha256}, got ${actual}`);
      }
    }

    await fsp.rename(tmpPath, targetPath);
    return targetPath;
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function ensureDriveFile(logicalPath, { forceRefresh = false } = {}) {
  const entry = getDriveFileEntry(logicalPath);
  if (!entry) return null;

  const targetPath = getCachedFilePath(entry.key);
  if (!forceRefresh && fs.existsSync(targetPath)) {
    try {
      const stat = await fsp.stat(targetPath);
      if (!entry.size || stat.size === entry.size) {
        return {
          path: targetPath,
          entry,
          fromCache: true,
        };
      }
    } catch {
      // Redownload if stat fails
    }
  }

  if (inFlightFiles.has(entry.key)) {
    return inFlightFiles.get(entry.key);
  }

  const work = (async () => {
    console.log(`[gdrive] Downloading ${entry.key} (${entry.fileId})...`);
    await downloadDriveFileToDisk(entry.fileId, targetPath, {
      expectedSize: entry.size || null,
      expectedSha256: entry.sha256 || null,
      label: entry.key,
    });
    return {
      path: targetPath,
      entry,
      fromCache: false,
    };
  })();

  inFlightFiles.set(entry.key, work);
  try {
    return await work;
  } finally {
    inFlightFiles.delete(entry.key);
  }
}

export async function readDriveRange(fileId, start, end) {
  const res = await openDriveDownloadResponse(fileId, {
    rangeHeader: `bytes=${start}-${end}`,
    timeoutMs: 30_000,
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`Google Drive did not honor Range request (status ${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function getBundleForZoom(z) {
  const zoom = Number(z);
  const manifest = loadDriveManifest();
  for (const [bundleKey, meta] of Object.entries(manifest.bundles || {})) {
    if (Array.isArray(meta.zooms) && meta.zooms.includes(zoom) && meta.tarFileId && meta.indexFileId) {
      return { bundleKey, ...meta };
    }
  }
  return null;
}

export function getBundlePaths(bundleKey) {
  const dir = path.join(getCacheRoot(), 'bundles');
  return {
    dir,
    tarPath: path.join(dir, `${bundleKey}.tar`),
    indexPath: path.join(dir, `${bundleKey}.tar.idx.gz`),
  };
}

export async function ensureBundleIndex(bundleMeta) {
  const { bundleKey, indexFileId, indexSize, indexSha256 } = bundleMeta;
  if (parsedBundleIndices.has(bundleKey)) {
    return parsedBundleIndices.get(bundleKey);
  }
  if (inFlightBundleIndices.has(bundleKey)) {
    return inFlightBundleIndices.get(bundleKey);
  }

  const work = (async () => {
    const { indexPath } = getBundlePaths(bundleKey);
    let needDownload = true;
    if (fs.existsSync(indexPath)) {
      const stat = await fsp.stat(indexPath);
      if (!indexSize || stat.size === indexSize) {
        needDownload = false;
      }
    }
    if (needDownload) {
      await downloadDriveFileToDisk(indexFileId, indexPath, {
        expectedSize: indexSize || null,
        expectedSha256: indexSha256 || null,
        label: `${bundleKey}.tar.idx.gz`,
      });
    }
    const gz = await fsp.readFile(indexPath);
    const jsonText = zlib.gunzipSync(gz).toString('utf8');
    const obj = JSON.parse(jsonText);
    const map = new Map(Object.entries(obj));
    parsedBundleIndices.set(bundleKey, map);
    return map;
  })();

  inFlightBundleIndices.set(bundleKey, work);
  try {
    return await work;
  } finally {
    inFlightBundleIndices.delete(bundleKey);
  }
}

export async function ensureBundleTar(bundleMeta) {
  const { bundleKey, tarFileId, tarSize, tarSha256 } = bundleMeta;
  const { tarPath } = getBundlePaths(bundleKey);
  if (fs.existsSync(tarPath)) {
    const stat = await fsp.stat(tarPath);
    if (!tarSize || stat.size === tarSize) {
      return tarPath;
    }
  }
  if (inFlightBundles.has(bundleKey)) {
    return inFlightBundles.get(bundleKey);
  }

  const work = (async () => {
    console.log(`[gdrive] Downloading tile bundle ${bundleKey}.tar...`);
    await downloadDriveFileToDisk(tarFileId, tarPath, {
      expectedSize: tarSize || null,
      expectedSha256: tarSha256 || null,
      label: `${bundleKey}.tar`,
    });
    return tarPath;
  })();

  inFlightBundles.set(bundleKey, work);
  try {
    return await work;
  } finally {
    inFlightBundles.delete(bundleKey);
  }
}

async function readLocalTarSlice(tarPath, offset, size) {
  const handle = await fsp.open(tarPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(size);
    let readTotal = 0;
    while (readTotal < size) {
      const { bytesRead } = await handle.read(buf, readTotal, size - readTotal, offset + readTotal);
      if (bytesRead <= 0) break;
      readTotal += bytesRead;
    }
    if (readTotal !== size) {
      throw new Error(`Incomplete tar slice read (${readTotal}/${size})`);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a single LRO WAC tile (`z/x/y.jpg`) from Google Drive bundles.
 * - If the bundle `.tar` is already cached locally, reads the exact byte slice in <1 ms.
 * - Otherwise checks per-tile cache (`cache/gdrive/tiles/lro_wac/...`) and reads the exact
 *   byte slice directly from Google Drive via HTTP Range (with optional small-bundle prefetch).
 */
export async function readLroWacTileFromDrive(z, x, y) {
  const bundle = getBundleForZoom(z);
  if (!bundle) return null;

  const indexMap = await ensureBundleIndex(bundle);
  const relKey = `${z}/${x}/${y}.jpg`;
  const loc = indexMap.get(relKey);
  if (!loc) return null;

  const [offset, size] = loc;
  const { tarPath } = getBundlePaths(bundle.bundleKey);

  if (fs.existsSync(tarPath)) {
    try {
      const stat = await fsp.stat(tarPath);
      if (!bundle.tarSize || stat.size === bundle.tarSize) {
        return await readLocalTarSlice(tarPath, offset, size);
      }
    } catch {
      // Fall through to per-tile cache / Range
    }
  }

  const cachedTilePath = path.join(getCacheRoot(), 'tiles', 'lro_wac', String(z), String(x), `${y}.jpg`);
  if (fs.existsSync(cachedTilePath)) {
    try {
      const stat = await fsp.stat(cachedTilePath);
      if (stat.size === size) {
        return new Uint8Array(await fsp.readFile(cachedTilePath));
      }
    } catch {
      // Fall through to Range
    }
  }

  // Pre-cache small bundles (<= 150 MB) or all bundles when explicitly requested
  if ((bundle.tarSize || 0) <= 150 * 1024 * 1024 || process.env.GDRIVE_PREFETCH_BUNDLES === '1') {
    ensureBundleTar(bundle).catch((err) => {
      console.warn(`[gdrive] Bundle ${bundle.bundleKey} background download failed: ${err.message}`);
    });
  }

  try {
    const slice = await readDriveRange(bundle.tarFileId, offset, offset + size - 1);
    if (slice && slice.byteLength === size) {
      fsp
        .mkdir(path.dirname(cachedTilePath), { recursive: true })
        .then(() => fsp.writeFile(cachedTilePath, slice))
        .catch(() => {});
      return slice;
    }
  } catch {
    // Fall through to full bundle download fallback
  }

  if ((bundle.tarSize || 0) <= 150 * 1024 * 1024) {
    try {
      await ensureBundleTar(bundle);
      return await readLocalTarSlice(tarPath, offset, size);
    } catch {
      return null;
    }
  }

  return null;
}
