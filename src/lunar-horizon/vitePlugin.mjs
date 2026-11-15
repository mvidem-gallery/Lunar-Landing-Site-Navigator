import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ephemeris, terrainDetail, imageryTile } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLIENT_DIR = path.join(__dirname, 'client');
const DATA_DIR = path.join(PROJECT_ROOT, 'lunar-horizon-latest/lunar-horizon/data');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'lunar-horizon-latest/lunar-horizon/assets');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.packed': 'application/octet-stream',
  '.webp': 'image/webp',
};

const STATIC_CLIENT_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'dem.js',
  'imagery.js',
  'lander.js',
  'math.js',
  'mission.js',
  'sky.js',
  'sky-render.js',
  'terrain-mesh.js',
  'terrain-worker.js',
];

const STATIC_DATA_FILES = ['terrain.json', 'far.json', 'global-dem.bin'];
const STATIC_ASSET_FILES = ['three.js', 'earth-blue-marble.webp', 'stars-hyg.bin'];

function packPolarDem(name) {
  const metaPath = path.join(DATA_DIR, `${name}.json`);
  const binPath = path.join(DATA_DIR, `${name}.bin`);
  const { width, height } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const source = fs.readFileSync(binPath);
  const floats = new Float32Array(source.buffer, source.byteOffset, width * height);
  const packed = Buffer.allocUnsafe(width * height * 2);

  for (let row = 0; row < height; row++) {
    let previous = 0;
    const rowStart = row * width;
    const rowEnd = rowStart + width;
    for (let i = rowStart; i < rowEnd; i++) {
      const meters = floats[i];
      const value = Number.isFinite(meters) ? Math.round(meters * 2) : -32768;
      packed.writeUInt16LE((value - previous) & 0xffff, i * 2);
      previous = value;
    }
  }

  return gzipSync(packed);
}

async function handleApiRoute(pathname, fullUrl, res) {
  try {
    if (pathname === '/api/ephemeris') {
      const data = await ephemeris(fullUrl);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(JSON.stringify(data));
      return true;
    }

    if (pathname === '/api/terrain-detail' || pathname === '/api/imagery') {
      const result =
        pathname === '/api/imagery'
          ? await imageryTile(fullUrl)
          : await terrainDetail(fullUrl, { preferCompactRanges: true });

      res.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.status === 204 || result.status === 304) {
        res.end();
      } else {
        res.end(Buffer.from(await result.arrayBuffer()));
      }
      return true;
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err?.message || 'Service temporarily unavailable.' }));
    return true;
  }

  return false;
}

export function lunarHorizonPlugin() {
  const packedCache = new Map();

  const getPackedAsset = (name) => {
    if (!packedCache.has(name)) {
      packedCache.set(name, packPolarDem(name));
    }
    return packedCache.get(name);
  };

  return {
    name: 'lunar-horizon-integration',

    configureServer(server) {
      // Фоновий прогрів стиснутих полярних карт у пам'ять, щоб не блокувати перший перехід на полюс
      setTimeout(() => {
        try {
          getPackedAsset('terrain');
          getPackedAsset('far');
        } catch {
          // Ігноруємо, якщо файли ще недоступні
        }
      }, 150).unref?.();

      server.middlewares.use('/lunar-horizon', async (req, res, next) => {
        try {
          const originalUrl = req.originalUrl || req.url || '/';
          const parsedOriginal = new URL(originalUrl, 'http://localhost');

          // Забезпечуємо коректну базу для відносних шляхів (./app.js, ./api/...)
          if (parsedOriginal.pathname === '/lunar-horizon') {
            res.writeHead(302, { Location: `/lunar-horizon/${parsedOriginal.search}` });
            res.end();
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const pathname = url.pathname;

          if (await handleApiRoute(pathname, url, res)) {
            return;
          }

          if (pathname === '/terrain.packed' || pathname === '/far.packed') {
            const name = pathname.slice(1, pathname.indexOf('.'));
            const payload = getPackedAsset(name);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': payload.byteLength,
              'Cache-Control': 'public, max-age=604800',
            });
            res.end(payload);
            return;
          }

          let filePath = null;
          if (pathname === '/' || pathname === '/index.html') {
            filePath = path.join(CLIENT_DIR, 'index.html');
          } else {
            const rel = pathname.replace(/^\/+/, '');
            if (!rel.includes('..')) {
              const candidateClient = path.join(CLIENT_DIR, rel);
              const candidateData = path.join(DATA_DIR, rel);
              const candidateAsset = path.join(ASSETS_DIR, rel);
              if (STATIC_CLIENT_FILES.includes(rel) && fs.existsSync(candidateClient)) {
                filePath = candidateClient;
              } else if (STATIC_ASSET_FILES.includes(rel) && fs.existsSync(candidateAsset)) {
                filePath = candidateAsset;
              } else if (STATIC_DATA_FILES.includes(rel) && fs.existsSync(candidateData)) {
                filePath = candidateData;
              }
            }
          }

          if (!filePath || !fs.existsSync(filePath)) {
            next();
            return;
          }

          const ext = path.extname(filePath);
          const isStaticAsset =
            filePath.startsWith(ASSETS_DIR) ||
            ext === '.bin' ||
            ext === '.packed' ||
            (ext === '.json' && filePath.startsWith(DATA_DIR));
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': isStaticAsset
              ? 'public, max-age=604800'
              : ext === '.html' || ext === '.js'
                ? 'no-cache'
                : 'public, max-age=3600',
          });
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err?.message || 'Internal Lunar Horizon error.' }));
        }
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use('/lunar-horizon', async (req, res, next) => {
        const originalUrl = req.originalUrl || req.url || '/';
        const parsedOriginal = new URL(originalUrl, 'http://localhost');
        if (parsedOriginal.pathname === '/lunar-horizon') {
          res.writeHead(302, { Location: `/lunar-horizon/${parsedOriginal.search}` });
          res.end();
          return;
        }

        const url = new URL(req.url || '/', 'http://localhost');
        if (await handleApiRoute(url.pathname, url, res)) {
          return;
        }
        next();
      });
    },

    writeBundle(outputOptions) {
      const outDir = outputOptions.dir || path.join(PROJECT_ROOT, 'dist');
      const targetDir = path.join(outDir, 'lunar-horizon');
      fs.mkdirSync(targetDir, { recursive: true });

      for (const file of STATIC_CLIENT_FILES) {
        fs.copyFileSync(path.join(CLIENT_DIR, file), path.join(targetDir, file));
      }

      for (const file of STATIC_ASSET_FILES) {
        fs.copyFileSync(path.join(ASSETS_DIR, file), path.join(targetDir, file));
      }

      for (const file of STATIC_DATA_FILES) {
        fs.copyFileSync(path.join(DATA_DIR, file), path.join(targetDir, file));
      }

      for (const name of ['terrain', 'far']) {
        fs.writeFileSync(path.join(targetDir, `${name}.packed`), getPackedAsset(name));
      }
    },
  };
}
