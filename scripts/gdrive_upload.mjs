#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_FOLDER_ID = '1HiP8G283SCx7foxLqQVH4wFWNkE1_mJX';
const DEFAULT_MANIFEST_PATH = path.join(PROJECT_ROOT, 'drive-manifest.json');
const DEFAULT_TOKEN_PATH = path.join(PROJECT_ROOT, '.gdrive-token.json');
const DEFAULT_STAGING_DIR = path.join(PROJECT_ROOT, '.gdrive-staging', 'tiles-bundles');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB (multiple of 256 KiB)

const TILE_BUNDLES = [
  { bundleKey: 'lro_wac_z2_z5', zooms: [2, 3, 4, 5] },
  { bundleKey: 'lro_wac_z6', zooms: [6] },
  { bundleKey: 'lro_wac_z7', zooms: [7] },
  { bundleKey: 'lro_wac_z8', zooms: [8] },
];

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.bin': 'application/octet-stream',
  '.img': 'application/octet-stream',
  '.bsp': 'application/octet-stream',
  '.bpc': 'application/octet-stream',
  '.pca': 'application/octet-stream',
  '.epa': 'application/octet-stream',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

function parseArgs(argv) {
  const opts = {
    folderId: process.env.GDRIVE_FOLDER_ID?.trim() || DEFAULT_FOLDER_ID,
    credentialsPath: process.env.GDRIVE_CREDENTIALS?.trim() || null,
    tokenPath: process.env.GDRIVE_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH,
    manifestPath: process.env.GDRIVE_MANIFEST_PATH?.trim() || DEFAULT_MANIFEST_PATH,
    stagingDir: process.env.GDRIVE_STAGING_DIR?.trim() || DEFAULT_STAGING_DIR,
    dryRun: false,
    authOnly: false,
    packOnly: false,
    uploadOnly: false,
    repack: false,
    keepStaging: false,
    noPublic: false,
    only: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--auth-only') opts.authOnly = true;
    else if (arg === '--pack-only') opts.packOnly = true;
    else if (arg === '--upload-only') opts.uploadOnly = true;
    else if (arg === '--repack') opts.repack = true;
    else if (arg === '--keep-staging') opts.keepStaging = true;
    else if (arg === '--no-public') opts.noPublic = true;
    else if (arg === '--folder' && argv[i + 1]) opts.folderId = argv[++i];
    else if (arg === '--credentials' && argv[i + 1]) opts.credentialsPath = argv[++i];
    else if (arg === '--token' && argv[i + 1]) opts.tokenPath = argv[++i];
    else if (arg === '--manifest' && argv[i + 1]) opts.manifestPath = argv[++i];
    else if (arg === '--staging-dir' && argv[i + 1]) opts.stagingDir = path.resolve(argv[++i]);
    else if (arg === '--only' && argv[i + 1]) {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const activeModes = [
    opts.dryRun && '--dry-run',
    opts.authOnly && '--auth-only',
    opts.packOnly && '--pack-only',
    opts.uploadOnly && '--upload-only',
  ].filter(Boolean);
  if (activeModes.length > 1) {
    throw new Error(`Flags ${activeModes.join(' and ')} cannot be combined.`);
  }
  return opts;
}

function printUsage() {
  console.log(`
Google Drive Asset Uploader & Manifest Builder

Usage:
  node scripts/gdrive_upload.mjs [options]

Options:
  --folder <id>         Google Drive folder ID (default: ${DEFAULT_FOLDER_ID})
  --credentials <path>  Path to OAuth client JSON (gdrive-credentials.json / client_secret*.json)
  --token <path>        Path to OAuth token cache (default: .gdrive-token.json)
  --manifest <path>     Output manifest JSON (default: drive-manifest.json)
  --staging-dir <path>  Staging directory for .tar bundles (default: .gdrive-staging/tiles-bundles)
  --only <filters>      Comma-separated filter (e.g. earth,stars,terrain,kernels,report,lunar-horizon,tiles)
  --dry-run             List files/bundles and sizes without packing or uploading
  --auth-only           Run browser OAuth & verify folder only (no tile scanning or archive building)
  --pack-only           Analyze assets & create LRO WAC .tar bundles offline (no browser / no upload)
  --upload-only         Upload pre-packed bundles from staging dir without re-scanning/re-packing tiles
  --repack              Force rebuilding staged .tar bundles instead of reusing existing ones
  --keep-staging        Keep .gdrive-staging/tiles-bundles/*.tar after upload
  --no-public           Do not set 'anyone:reader' permission on uploaded files
  -h, --help            Show help
`.trim());
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function normalizePosix(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function listFilesIfExists(relDir, predicate) {
  const absDir = path.join(PROJECT_ROOT, ...relDir.split('/'));
  if (!fs.existsSync(absDir)) return [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (predicate && !predicate(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    const stat = fs.statSync(absPath);
    out.push({
      logicalPath: `${relDir}/${entry.name}`,
      absPath,
      size: stat.size,
      contentType: MIME_BY_EXT[path.extname(entry.name).toLowerCase()] || 'application/octet-stream',
    });
  }
  out.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return out;
}

function discoverIndividualAssets() {
  const items = [
    ...listFilesIfExists('public/earth', (n) => !n.startsWith('.')).map((x) => ({ ...x, category: 'earth' })),
    ...listFilesIfExists('public/stars', (n) => !n.startsWith('.')).map((x) => ({ ...x, category: 'stars' })),
    ...listFilesIfExists('public/trajectories', (n) => n.endsWith('.json')).map((x) => ({ ...x, category: 'trajectories' })),
    ...listFilesIfExists('lunar-horizon-latest/lunar-horizon/data', (n) => n.endsWith('.bin')).map((x) => ({ ...x, category: 'lunar-horizon' })),
    ...listFilesIfExists('lunar-horizon-latest/lunar-horizon/assets', (n) =>
      ['three.js', 'earth-blue-marble.webp', 'stars-hyg.bin'].includes(n)
    ).map((x) => ({ ...x, category: 'lunar-horizon' })),
    ...listFilesIfExists('report/lunar-report-dss/src/data', (n) => n.endsWith('.bin')).map((x) => ({ ...x, category: 'report' })),
    ...listFilesIfExists(
      'trajectory/Lunar-Window-Navigator/launch-window-prediction/data/terrain',
      (n) => n.toLowerCase().endsWith('.img')
    ).map((x) => ({ ...x, category: 'terrain' })),
    ...listFilesIfExists(
      'trajectory/Lunar-Window-Navigator/launch-window-prediction/data/kernels',
      (n) => ['.bsp', '.bpc', '.pca', '.epa'].includes(path.extname(n).toLowerCase())
    ).map((x) => ({ ...x, category: 'kernels' })),
  ];
  return items;
}

function scanLroWacZoomStats(zooms) {
  const baseDir = path.join(PROJECT_ROOT, 'public', 'tiles', 'lro_wac');
  let count = 0;
  let totalBytes = 0;
  const files = [];

  for (const z of zooms) {
    const zDir = path.join(baseDir, String(z));
    if (!fs.existsSync(zDir)) continue;
    const xDirs = fs.readdirSync(zDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    xDirs.sort((a, b) => Number(a.name) - Number(b.name));
    for (const xd of xDirs) {
      const xPath = path.join(zDir, xd.name);
      const yFiles = fs.readdirSync(xPath, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jpg'));
      yFiles.sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10));
      for (const yf of yFiles) {
        const absPath = path.join(xPath, yf.name);
        const st = fs.statSync(absPath);
        count++;
        totalBytes += st.size;
        files.push({
          relKey: `${z}/${xd.name}/${yf.name}`,
          absPath,
          size: st.size,
          mtimeMs: Math.floor(st.mtimeMs / 1000),
        });
      }
    }
  }
  return { count, totalBytes, files };
}

function buildUstarHeader(name, size, mtimeSec) {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 99) {
    throw new Error(`TAR entry name exceeds 99 bytes: ${name}`);
  }
  const hdr = Buffer.alloc(512, 0);
  nameBuf.copy(hdr, 0);
  hdr.write('0000644\0', 100, 'ascii');
  hdr.write('0000000\0', 108, 'ascii');
  hdr.write('0000000\0', 116, 'ascii');
  hdr.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  hdr.write(Math.max(0, mtimeSec).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  hdr.fill(0x20, 148, 156); // checksum field spaces for sum calculation
  hdr.write('0', 156, 'ascii');
  hdr.write('ustar\0', 257, 'ascii');
  hdr.write('00', 263, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += hdr[i];
  hdr.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return hdr;
}

async function createTileBundleTar(bundleSpec, stagingDir) {
  const { bundleKey, zooms } = bundleSpec;
  const tarPath = path.join(stagingDir, `${bundleKey}.tar`);
  const indexPath = path.join(stagingDir, `${bundleKey}.tar.idx.gz`);
  const metaPath = path.join(stagingDir, `${bundleKey}.meta.json`);

  console.log(`[pack] Scanning public/tiles/lro_wac zooms [${zooms.join(', ')}]...`);
  const { count, totalBytes, files } = scanLroWacZoomStats(zooms);
  if (count === 0) {
    console.log(`[pack] Skipping ${bundleKey}: no tiles found locally.`);
    return null;
  }
  console.log(`[pack] Packing ${count} tiles (${formatBytes(totalBytes)}) into ${bundleKey}.tar...`);

  await fsp.mkdir(stagingDir, { recursive: true });
  const tmpTarPath = `${tarPath}.tmp`;
  const tmpIdxPath = `${indexPath}.tmp`;
  const tmpMetaPath = `${metaPath}.tmp`;

  const indexMap = {};
  const fd = await fsp.open(tmpTarPath, 'w');
  let archiveOffset = 0;
  const started = Date.now();
  let lastLog = 0;

  try {
    const zeroPad = Buffer.alloc(512, 0);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const hdr = buildUstarHeader(f.relKey, f.size, f.mtimeMs);
      await fd.write(hdr);
      archiveOffset += 512;

      const dataOffset = archiveOffset;
      const content = await fsp.readFile(f.absPath);
      if (content.length !== f.size) {
        throw new Error(`File size changed while packing: ${f.absPath}`);
      }
      await fd.write(content);
      archiveOffset += content.length;

      const rem = content.length % 512;
      if (rem !== 0) {
        const padLen = 512 - rem;
        await fd.write(zeroPad, 0, padLen);
        archiveOffset += padLen;
      }

      indexMap[f.relKey] = [dataOffset, f.size];

      const now = Date.now();
      if (now - lastLog > 2000 || i === files.length - 1) {
        const pct = (((i + 1) / files.length) * 100).toFixed(1);
        console.log(`[pack] ${bundleKey}: ${i + 1}/${files.length} (${pct}%)`);
        lastLog = now;
      }
    }

    // Two 512-byte EOF blocks
    await fd.write(Buffer.alloc(1024, 0));
    archiveOffset += 1024;
  } finally {
    await fd.close();
  }

  const indexJson = Buffer.from(JSON.stringify(indexMap), 'utf8');
  const indexGz = zlib.gzipSync(indexJson, { level: 9 });
  await fsp.writeFile(tmpIdxPath, indexGz);
  const metaDoc = {
    bundleKey,
    zooms,
    tileCount: count,
    sourceTotalBytes: totalBytes,
    tarSize: archiveOffset,
    indexSize: indexGz.length,
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(tmpMetaPath, JSON.stringify(metaDoc, null, 2) + '\n', 'utf8');

  await fsp.rename(tmpTarPath, tarPath);
  await fsp.rename(tmpIdxPath, indexPath);
  await fsp.rename(tmpMetaPath, metaPath);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[pack] Built ${bundleKey}.tar (${formatBytes(archiveOffset)}) + ${bundleKey}.tar.idx.gz (${formatBytes(indexGz.length)}) in ${elapsed}s`
  );

  return {
    bundleKey,
    zooms,
    tileCount: count,
    tarPath,
    indexPath,
    tarSize: archiveOffset,
    indexSize: indexGz.length,
  };
}

async function loadStagedTileBundle(bundleSpec, stagingDir) {
  const { bundleKey, zooms } = bundleSpec;
  const tarPath = path.join(stagingDir, `${bundleKey}.tar`);
  const indexPath = path.join(stagingDir, `${bundleKey}.tar.idx.gz`);
  const metaPath = path.join(stagingDir, `${bundleKey}.meta.json`);

  if (!fs.existsSync(tarPath) || !fs.existsSync(indexPath)) {
    return null;
  }

  const tarStat = await fsp.stat(tarPath);
  const idxStat = await fsp.stat(indexPath);
  if (tarStat.size <= 0 || idxStat.size <= 0) {
    return null;
  }

  let tileCount = null;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (
        meta &&
        meta.bundleKey === bundleKey &&
        meta.tarSize === tarStat.size &&
        meta.indexSize === idxStat.size &&
        Number.isFinite(Number(meta.tileCount)) &&
        Number(meta.tileCount) > 0
      ) {
        tileCount = Number(meta.tileCount);
      }
    } catch {
      tileCount = null;
    }
  }

  if (tileCount === null) {
    try {
      const gzBuf = await fsp.readFile(indexPath);
      const idxMap = JSON.parse(zlib.gunzipSync(gzBuf).toString('utf8'));
      const keys = Object.keys(idxMap);
      if (keys.length === 0) return null;
      tileCount = keys.length;
      const metaDoc = {
        bundleKey,
        zooms,
        tileCount,
        tarSize: tarStat.size,
        indexSize: idxStat.size,
        createdAt: new Date().toISOString(),
      };
      await fsp.writeFile(metaPath, JSON.stringify(metaDoc, null, 2) + '\n', 'utf8').catch(() => {});
    } catch {
      return null;
    }
  }

  console.log(
    `[pack] Reusing staged ${bundleKey}.tar (${formatBytes(tarStat.size)}, ${tileCount} tiles; pass --repack to rebuild)`
  );
  return {
    bundleKey,
    zooms,
    tileCount,
    tarPath,
    indexPath,
    tarSize: tarStat.size,
    indexSize: idxStat.size,
  };
}

function loadStagingPlan(stagingDir) {
  const planPath = path.join(stagingDir, '_staging-manifest.json');
  if (!fs.existsSync(planPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
}

async function saveStagingPlan(stagingDir, plan) {
  await fsp.mkdir(stagingDir, { recursive: true });
  const planPath = path.join(stagingDir, '_staging-manifest.json');
  const tmpPath = `${planPath}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await fsp.rename(tmpPath, planPath);
}

async function computeHashes(filePath) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const sha256 = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha256.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({
        md5: md5.digest('hex'),
        sha256: sha256.digest('hex'),
      });
    });
  });
}

function findCredentialsFile(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Credentials file not found: ${resolved}`);
    }
    return resolved;
  }
  const candidates = ['gdrive-credentials.json', 'credentials.json'];
  for (const name of candidates) {
    const p = path.join(PROJECT_ROOT, name);
    if (fs.existsSync(p)) return p;
  }
  const clientSecrets = fs
    .readdirSync(PROJECT_ROOT)
    .filter((f) => /^client_secret.*\.json$/i.test(f))
    .sort();
  if (clientSecrets.length > 0) {
    return path.join(PROJECT_ROOT, clientSecrets[0]);
  }
  throw new Error(
    `OAuth credentials file not found in ${PROJECT_ROOT}.\n` +
      `Download OAuth Desktop Client JSON from Google Cloud Console and save it as:\n` +
      `  ${path.join(PROJECT_ROOT, 'gdrive-credentials.json')}\n` +
      `or pass --credentials <path>.`
  );
}

function loadOAuthClientConfig(credPath) {
  const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const cfg = raw.installed || raw.web || raw;
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(`Invalid OAuth credentials JSON in ${credPath}: missing client_id/client_secret`);
  }
  return cfg;
}

function openBrowserUrl(url) {
  try {
    if (process.platform === 'win32') {
      const psUrl = url.replace(/'/g, "''");
      spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${psUrl}'`],
        { detached: true, stdio: 'ignore', windowsHide: true }
      ).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // User can open URL manually
  }
}

async function exchangeOAuthCode(cfg, code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  return {
    ...data,
    expiry_date: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  };
}

async function refreshOAuthToken(cfg, token) {
  if (!token.refresh_token) return null;
  const body = new URLSearchParams({
    refresh_token: token.refresh_token,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    return null;
  }
  return {
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
    expiry_date: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  };
}

async function authorizeInteractive(cfg) {
  const state = crypto.randomBytes(16).toString('hex');
  let resolveCode;
  const codePromise = new Promise((resolve) => {
    resolveCode = resolve;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/oauth2callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const err = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    const gotState = reqUrl.searchParams.get('state');
    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>Authorization failed: ${err}</h3>`);
      resolveCode({ error: err });
      return;
    }
    if (!code || gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Invalid OAuth callback state.</h3>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Google Drive authorized! You may close this browser tab and return to the terminal.</h2>');
    resolveCode({ code });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;

  const authParams = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  const authUrl = `${OAUTH_AUTH_URL}?${authParams.toString()}`;

  console.log('\n[auth] Open this URL in your browser to authorize Google Drive upload:');
  console.log(`  ${authUrl}\n`);
  openBrowserUrl(authUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const manualPromise = new Promise((resolve) => {
    rl.question(
      '[auth] Waiting for browser callback (or paste the authorization code / redirect URL here): ',
      (ans) => {
        const line = ans.trim();
        if (!line) {
          resolve(null);
          return;
        }
        if (line.startsWith('http://') || line.startsWith('https://')) {
          const u = new URL(line);
          resolve({ code: u.searchParams.get('code') });
          return;
        }
        resolve({ code: line });
      }
    );
  });

  const result = await Promise.race([
    codePromise,
    manualPromise.then((r) => r || new Promise(() => {})),
  ]);

  rl.close();
  server.closeAllConnections?.();
  server.close();
  if (!result || result.error || !result.code) {
    throw new Error(`OAuth authorization failed: ${result?.error || 'no code received'}`);
  }
  return exchangeOAuthCode(cfg, result.code, redirectUri);
}

async function getAuthManager(opts) {
  const credPath = findCredentialsFile(opts.credentialsPath);
  const cfg = loadOAuthClientConfig(credPath);
  let token = null;

  if (fs.existsSync(opts.tokenPath)) {
    try {
      token = JSON.parse(fs.readFileSync(opts.tokenPath, 'utf8'));
    } catch {
      token = null;
    }
  }

  async function saveToken(t) {
    await fsp.writeFile(opts.tokenPath, JSON.stringify(t, null, 2), 'utf8');
  }

  async function ensureToken(forceRefresh = false) {
    if (token && !forceRefresh && token.access_token && Date.now() < (token.expiry_date || 0)) {
      return token.access_token;
    }
    if (token?.refresh_token) {
      const refreshed = await refreshOAuthToken(cfg, token);
      if (refreshed) {
        token = refreshed;
        await saveToken(token);
        return token.access_token;
      }
    }
    token = await authorizeInteractive(cfg);
    await saveToken(token);
    return token.access_token;
  }

  await ensureToken();
  return { getAccessToken: ensureToken };
}

async function driveJsonRequest(auth, url, init = {}, retries = 4) {
  let attempt = 0;
  while (true) {
    const accessToken = await auth.getAccessToken(attempt > 0 && init._forceRefresh);
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
      },
    });
    if (res.status === 401 && attempt === 0) {
      attempt++;
      init._forceRefresh = true;
      await res.body?.cancel();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      attempt++;
      await res.body?.cancel();
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.error?.message || text || `HTTP ${res.status}`;
      throw new Error(`Drive API error (${res.status}): ${msg}`);
    }
    return json;
  }
}

function escapeDriveQuery(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const folderIdCache = new Map();

async function verifyTargetFolder(auth, folderId) {
  const url = `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`;
  const meta = await driveJsonRequest(auth, url);
  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(`Target ID ${folderId} is not a Google Drive folder (mimeType=${meta.mimeType})`);
  }
  console.log(`[drive] Target folder: "${meta.name}" (${meta.id})`);
  folderIdCache.set('', folderId);
  return meta;
}

async function ensureSubfolderPath(auth, rootFolderId, relFolderPosix) {
  const clean = normalizePosix(relFolderPosix).replace(/\/+$/, '');
  if (!clean) return rootFolderId;
  if (folderIdCache.has(clean)) return folderIdCache.get(clean);

  const parts = clean.split('/');
  let parentId = rootFolderId;
  let prefix = '';

  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (folderIdCache.has(prefix)) {
      parentId = folderIdCache.get(prefix);
      continue;
    }
    const q = `name='${escapeDriveQuery(part)}' and '${escapeDriveQuery(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const listUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const listed = await driveJsonRequest(auth, listUrl);
    if (listed.files && listed.files.length > 0) {
      parentId = listed.files[0].id;
    } else {
      const created = await driveJsonRequest(
        auth,
        `${DRIVE_API}/files?fields=id,name&supportsAllDrives=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: part,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          }),
        }
      );
      parentId = created.id;
    }
    folderIdCache.set(prefix, parentId);
  }
  return parentId;
}

async function findExistingFileInFolder(auth, parentId, name) {
  const q = `name='${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum,permissions(id,type,role))&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await driveJsonRequest(auth, url);
  return res.files?.[0] || null;
}

async function ensurePublicReaderPermission(auth, fileMeta) {
  const perms = fileMeta.permissions || [];
  if (perms.some((p) => p.type === 'anyone' && (p.role === 'reader' || p.role === 'writer' || p.role === 'owner'))) {
    return;
  }
  await driveJsonRequest(
    auth,
    `${DRIVE_API}/files/${encodeURIComponent(fileMeta.id)}/permissions?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }
  );
}

async function uploadResumable(auth, { filePath, fileName, parentId, mimeType, existingFileId = null, label }) {
  const stat = await fsp.stat(filePath);
  const totalBytes = stat.size;
  const fields = 'id,name,size,md5Checksum';

  let sessionUrl = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await auth.getAccessToken(attempt > 0);
    const endpoint = existingFileId
      ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=${fields}&supportsAllDrives=true`
      : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${fields}&supportsAllDrives=true`;

    const metadata = existingFileId
      ? { name: fileName, mimeType }
      : { name: fileName, parents: [parentId], mimeType };

    const initRes = await fetch(endpoint, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(totalBytes),
      },
      body: JSON.stringify(metadata),
    });

    if (initRes.ok) {
      sessionUrl = initRes.headers.get('location');
      await initRes.body?.cancel();
      if (sessionUrl) break;
    } else {
      const errText = await initRes.text().catch(() => '');
      if (initRes.status !== 401 && initRes.status !== 429 && initRes.status < 500) {
        throw new Error(`Failed to initiate upload for ${label}: HTTP ${initRes.status} ${errText}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }

  if (!sessionUrl) {
    throw new Error(`No upload session location returned for ${label}`);
  }

  const handle = await fsp.open(filePath, 'r');
  const started = Date.now();
  let offset = 0;
  let lastLog = 0;

  try {
    if (totalBytes === 0) {
      const token = await auth.getAccessToken();
      const emptyRes = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': '0',
        },
      });
      const json = await emptyRes.json();
      if (!emptyRes.ok) {
        throw new Error(`Empty upload failed for ${label}: ${JSON.stringify(json)}`);
      }
      return json;
    }

    while (offset < totalBytes) {
      const len = Math.min(CHUNK_SIZE, totalBytes - offset);
      const buf = Buffer.allocUnsafe(len);
      let readSum = 0;
      while (readSum < len) {
        const { bytesRead } = await handle.read(buf, readSum, len - readSum, offset + readSum);
        if (bytesRead <= 0) break;
        readSum += bytesRead;
      }
      const chunk = readSum === len ? buf : buf.subarray(0, readSum);
      const end = offset + chunk.length - 1;

      let uploadedChunk = false;
      for (let retry = 0; retry < 6; retry++) {
        try {
          const token = await auth.getAccessToken(retry > 0);
          const putRes = await fetch(sessionUrl, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Length': String(chunk.length),
              'Content-Range': `bytes ${offset}-${end}/${totalBytes}`,
            },
            body: chunk,
            signal: AbortSignal.timeout(300_000),
          });

          if (putRes.status === 200 || putRes.status === 201) {
            const doneMeta = await putRes.json();
            return doneMeta;
          }
          if (putRes.status === 308) {
            const rangeHeader = putRes.headers.get('range');
            await putRes.body?.cancel();
            if (rangeHeader) {
              const m = /bytes=0-(\d+)/.exec(rangeHeader);
              offset = m ? Number(m[1]) + 1 : offset + chunk.length;
            } else {
              offset += chunk.length;
            }
            uploadedChunk = true;
            break;
          }
          const errText = await putRes.text().catch(() => '');
          if (putRes.status === 401 || putRes.status === 429 || putRes.status >= 500) {
            await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * 2 ** retry)));
            continue;
          }
          throw new Error(`Upload error (${putRes.status}) for ${label}: ${errText}`);
        } catch (err) {
          if (retry >= 5) throw err;
          await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * 2 ** retry)));
        }
      }

      if (!uploadedChunk) {
        throw new Error(`Exceeded retries uploading chunk for ${label}`);
      }

      const now = Date.now();
      if (totalBytes >= 5 * 1024 * 1024 && (now - lastLog > 1500 || offset >= totalBytes)) {
        const pct = ((offset / totalBytes) * 100).toFixed(1);
        const mbps = (offset / (1024 * 1024) / Math.max(0.2, (now - started) / 1000)).toFixed(1);
        console.log(`[upload] ${label}: ${pct}% (${formatBytes(offset)}/${formatBytes(totalBytes)}, ${mbps} MB/s)`);
        lastLog = now;
      }
    }
  } finally {
    await handle.close();
  }

  throw new Error(`Upload loop ended without completion metadata for ${label}`);
}

async function uploadOrReuseFile(auth, { absPath, driveFolderPath, driveFileName, contentType, rootFolderId, makePublic, label }) {
  const stat = await fsp.stat(absPath);
  const { md5, sha256 } = await computeHashes(absPath);
  const parentId = await ensureSubfolderPath(auth, rootFolderId, driveFolderPath);
  const existing = await findExistingFileInFolder(auth, parentId, driveFileName);

  let fileMeta = existing;
  let action = 'uploaded';

  if (existing && Number(existing.size) === stat.size && existing.md5Checksum === md5) {
    action = 'skipped (unchanged)';
  } else {
    fileMeta = await uploadResumable(auth, {
      filePath: absPath,
      fileName: driveFileName,
      parentId,
      mimeType: contentType,
      existingFileId: existing?.id || null,
      label,
    });
  }

  if (makePublic) {
    await ensurePublicReaderPermission(auth, fileMeta);
  }

  console.log(`[drive] ${action}: ${label} -> ${fileMeta.id} (${formatBytes(stat.size)})`);
  return {
    fileId: fileMeta.id,
    size: stat.size,
    md5,
    sha256,
    contentType,
  };
}

function loadOrInitManifest(manifestPath, folderId) {
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return {
        version: 1,
        provider: 'google-drive',
        folderId,
        folderUrl: `https://drive.google.com/drive/u/0/folders/${folderId}`,
        generatedAt: parsed.generatedAt || null,
        files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
        bundles: parsed.bundles && typeof parsed.bundles === 'object' ? parsed.bundles : {},
      };
    } catch {
      // recreate clean manifest
    }
  }
  return {
    version: 1,
    provider: 'google-drive',
    folderId,
    folderUrl: `https://drive.google.com/drive/u/0/folders/${folderId}`,
    generatedAt: null,
    files: {},
    bundles: {},
  };
}

async function saveManifest(manifestPath, manifest) {
  manifest.generatedAt = new Date().toISOString();
  const tmp = `${manifestPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, manifestPath);
}

function matchesOnlyFilter(filters, category, logicalPath) {
  if (!filters || filters.length === 0) return true;
  const hay = `${category} ${logicalPath}`.toLowerCase();
  return filters.some((f) => hay.includes(f));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Stage 1 option: standalone browser OAuth authorization without scanning/packing maps.
  if (opts.authOnly) {
    const auth = await getAuthManager(opts);
    await verifyTargetFolder(auth, opts.folderId);
    console.log(`\n[auth-only] OAuth token saved to: ${opts.tokenPath}`);
    console.log('            Next steps:');
    console.log('              1) npm run gdrive:pack        (analyze & pack maps offline)');
    console.log('              2) npm run gdrive:upload-only (upload packed bundles)');
    return;
  }

  const selectedBundles = TILE_BUNDLES.filter((b) =>
    matchesOnlyFilter(opts.only, 'tiles', `bundles/${b.bundleKey}`)
  );

  if (opts.dryRun) {
    const individualAssets = discoverIndividualAssets().filter((item) =>
      matchesOnlyFilter(opts.only, item.category, item.logicalPath)
    );
    let totalBytes = 0;
    console.log('\n=== Individual Heavy Assets ===');
    for (const item of individualAssets) {
      totalBytes += item.size;
      console.log(`  [${item.category}] ${item.logicalPath} (${formatBytes(item.size)})`);
    }
    console.log('\n=== LRO WAC Tile Bundles ===');
    for (const b of selectedBundles) {
      const stats = scanLroWacZoomStats(b.zooms);
      const staged = await loadStagedTileBundle(b, opts.stagingDir).catch(() => null);
      totalBytes += stats.totalBytes;
      console.log(
        `  [tiles] ${b.bundleKey}.tar (zooms ${b.zooms.join(',')}) -> ${stats.count} tiles (${formatBytes(stats.totalBytes)})${staged ? ' [staged]' : ''}`
      );
    }
    console.log(`\nTotal data: ${formatBytes(totalBytes)}`);
    console.log(`Staging directory: ${opts.stagingDir}`);
    console.log(`Target Drive folder: https://drive.google.com/drive/u/0/folders/${opts.folderId}`);
    return;
  }

  // Offline Stage: analyze assets & build .tar archives without touching browser/OAuth.
  if (opts.packOnly) {
    const individualAssets = discoverIndividualAssets().filter((item) =>
      matchesOnlyFilter(opts.only, item.category, item.logicalPath)
    );
    const bundlePlan = {};
    const packedBundles = [];

    console.log(`\n[pack-only] Analyzing ${individualAssets.length} individual assets & ${selectedBundles.length} tile bundles...`);
    for (const spec of selectedBundles) {
      let packed = !opts.repack ? await loadStagedTileBundle(spec, opts.stagingDir) : null;
      if (!packed) {
        packed = await createTileBundleTar(spec, opts.stagingDir);
      }
      if (packed) {
        packedBundles.push(packed);
        bundlePlan[spec.bundleKey] = {
          status: 'packed',
          zooms: packed.zooms,
          tileCount: packed.tileCount,
          tarSize: packed.tarSize,
          indexSize: packed.indexSize,
        };
      } else {
        bundlePlan[spec.bundleKey] = {
          status: 'empty',
          zooms: spec.zooms,
          tileCount: 0,
        };
      }
    }

    await saveStagingPlan(opts.stagingDir, {
      version: 1,
      createdAt: new Date().toISOString(),
      only: opts.only || null,
      individualAssets: individualAssets.map((item) => ({
        logicalPath: item.logicalPath,
        category: item.category,
        size: item.size,
        contentType: item.contentType,
      })),
      bundles: bundlePlan,
    });

    console.log(`\n[pack-only] Ready in ${opts.stagingDir}`);
    console.log(`            Individual assets analyzed: ${individualAssets.length}`);
    console.log(`            Tile bundles prepared: ${packedBundles.length}`);
    console.log('            Next: npm run gdrive:auth (if needed) && npm run gdrive:upload-only');
    return;
  }

  // Upload Stage (default or --upload-only): authorize FIRST so browser errors fail fast before any packing.
  const auth = await getAuthManager(opts);
  await verifyTargetFolder(auth, opts.folderId);

  const stagingPlan = loadStagingPlan(opts.stagingDir);
  const individualAssets = discoverIndividualAssets().filter((item) =>
    matchesOnlyFilter(opts.only, item.category, item.logicalPath)
  );

  const packedBundles = [];
  if (opts.uploadOnly) {
    for (const spec of selectedBundles) {
      const staged = await loadStagedTileBundle(spec, opts.stagingDir);
      if (staged) {
        packedBundles.push(staged);
        continue;
      }
      if (stagingPlan?.bundles?.[spec.bundleKey]?.status === 'empty') {
        console.log(`[upload-only] Skipping ${spec.bundleKey}: marked empty in staging manifest.`);
        continue;
      }
      throw new Error(
        `Staged bundle "${spec.bundleKey}.tar" not found in ${opts.stagingDir}. Run "npm run gdrive:pack" first or run without --upload-only.`
      );
    }
  } else {
    for (const spec of selectedBundles) {
      let packed = !opts.repack ? await loadStagedTileBundle(spec, opts.stagingDir) : null;
      if (!packed) {
        packed = await createTileBundleTar(spec, opts.stagingDir);
      }
      if (packed) packedBundles.push(packed);
    }
  }

  const manifest = loadOrInitManifest(opts.manifestPath, opts.folderId);

  for (const item of individualAssets) {
    const relFolder = path.posix.dirname(item.logicalPath);
    const fileName = path.posix.basename(item.logicalPath);
    const uploaded = await uploadOrReuseFile(auth, {
      absPath: item.absPath,
      driveFolderPath: relFolder === '.' ? '' : relFolder,
      driveFileName: fileName,
      contentType: item.contentType,
      rootFolderId: opts.folderId,
      makePublic: !opts.noPublic,
      label: item.logicalPath,
    });
    manifest.files[item.logicalPath] = {
      ...uploaded,
      category: item.category,
    };
    await saveManifest(opts.manifestPath, manifest);
  }

  for (const bundle of packedBundles) {
    const tarMeta = await uploadOrReuseFile(auth, {
      absPath: bundle.tarPath,
      driveFolderPath: 'bundles',
      driveFileName: `${bundle.bundleKey}.tar`,
      contentType: 'application/x-tar',
      rootFolderId: opts.folderId,
      makePublic: !opts.noPublic,
      label: `bundles/${bundle.bundleKey}.tar`,
    });

    const idxMeta = await uploadOrReuseFile(auth, {
      absPath: bundle.indexPath,
      driveFolderPath: 'bundles',
      driveFileName: `${bundle.bundleKey}.tar.idx.gz`,
      contentType: 'application/gzip',
      rootFolderId: opts.folderId,
      makePublic: !opts.noPublic,
      label: `bundles/${bundle.bundleKey}.tar.idx.gz`,
    });

    manifest.bundles[bundle.bundleKey] = {
      zooms: bundle.zooms,
      tileCount: bundle.tileCount,
      tarFileId: tarMeta.fileId,
      tarSize: tarMeta.size,
      tarMd5: tarMeta.md5,
      tarSha256: tarMeta.sha256,
      indexFileId: idxMeta.fileId,
      indexSize: idxMeta.size,
      indexMd5: idxMeta.md5,
      indexSha256: idxMeta.sha256,
    };
    await saveManifest(opts.manifestPath, manifest);

    if (!opts.keepStaging) {
      await fsp.unlink(bundle.tarPath).catch(() => {});
      await fsp.unlink(bundle.indexPath).catch(() => {});
      await fsp.unlink(path.join(opts.stagingDir, `${bundle.bundleKey}.meta.json`)).catch(() => {});
    }
  }

  if (!opts.keepStaging) {
    if (opts.stagingDir === DEFAULT_STAGING_DIR) {
      await fsp.rm(path.join(PROJECT_ROOT, '.gdrive-staging'), { recursive: true, force: true }).catch(() => {});
    } else {
      await fsp.rm(opts.stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\n[done] Updated manifest: ${opts.manifestPath}`);
  console.log(`       Files in manifest: ${Object.keys(manifest.files).length}`);
  console.log(`       Bundles in manifest: ${Object.keys(manifest.bundles).length}`);
}

main().catch((err) => {
  console.error(`\n[gdrive_upload] ERROR: ${err?.message || err}`);
  process.exit(1);
});
