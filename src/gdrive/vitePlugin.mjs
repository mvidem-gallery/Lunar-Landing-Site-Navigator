import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  ensureDriveFile,
  guessContentType,
  hasDriveFile,
  preferLocalAssets,
  readLroWacTileFromDrive,
} from './driveClient.mjs';

const STATIC_DRIVE_PREFIXES = ['/earth/', '/stars/', '/trajectories/'];

async function tryServeDriveStaticAsset(pathname, res) {
  const matchedPrefix = STATIC_DRIVE_PREFIXES.find((prefix) => pathname.startsWith(prefix));
  if (!matchedPrefix) return false;

  const relFromPublic = pathname.replace(/^\/+/, '');
  if (relFromPublic.includes('..')) return false;

  const logicalPath = `public/${relFromPublic}`;

  if (preferLocalAssets()) {
    const localPath = path.join(PROJECT_ROOT, 'public', ...relFromPublic.split('/'));
    if (fs.existsSync(localPath)) return false;
  }

  if (!hasDriveFile(logicalPath)) {
    return false;
  }

  const resolved = await ensureDriveFile(logicalPath);
  if (!resolved) return false;

  const data = await fsp.readFile(resolved.path);
  res.writeHead(200, {
    'Content-Type': resolved.entry.contentType || guessContentType(resolved.path),
    'Content-Length': data.byteLength,
    'Cache-Control': 'public, max-age=604800',
    'X-Asset-Source': 'google-drive',
  });
  res.end(data);
  return true;
}

async function tryServeDriveLroWacTile(pathname, res) {
  const m = /^\/tiles\/lro_wac\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(pathname);
  if (!m) return false;

  const [, z, x, y] = m;

  if (preferLocalAssets()) {
    const localTile = path.join(PROJECT_ROOT, 'public', 'tiles', 'lro_wac', z, x, `${y}.jpg`);
    if (fs.existsSync(localTile)) return false;
  }

  const bytes = await readLroWacTileFromDrive(Number(z), Number(x), Number(y));
  if (!bytes) {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'public, max-age=604800',
    'X-Asset-Source': 'google-drive-bundle',
  });
  res.end(bytes);
  return true;
}

export function createGdriveMiddleware() {
  return async function gdriveAssetsMiddleware(req, res, next) {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        next();
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      if (await tryServeDriveStaticAsset(pathname, res)) {
        return;
      }

      if (await tryServeDriveLroWacTile(pathname, res)) {
        return;
      }

      next();
    } catch (err) {
      console.warn(`[gdrive] Asset middleware fallback (${req.url}): ${err.message}`);
      next();
    }
  };
}

export function gdriveAssetsPlugin() {
  const middleware = createGdriveMiddleware();
  return {
    name: 'gdrive-assets-plugin',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
