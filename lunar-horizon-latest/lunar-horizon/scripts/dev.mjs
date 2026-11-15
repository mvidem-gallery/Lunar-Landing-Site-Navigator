import http from 'node:http';
import {createReadStream, existsSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {ephemeris, terrainDetail, imageryTile} from '../src/server.js';
import {createLocalCache} from './local-cache.mjs';

const types = {html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', bin: 'application/octet-stream'};
const day = 86400000;
const cachedResponse = createLocalCache('.lunar-cache');
const routes = new Map([
  ['/api/ephemeris', [async url => Response.json(await ephemeris(url)), 7 * day]],
  ['/api/terrain-detail', [terrainDetail, 30 * day]],
  ['/api/imagery', [imageryTile, 30 * day]],
]);
const polarRoutes = new Map([['/terrain.packed', 'terrain'], ['/far.packed', 'far']]);
const polarAssets = new Map();

async function preparePolarAsset(name) {
  const files = await Promise.all(['bin', 'json'].map(ext => stat(`data/${name}.${ext}`)));
  const key = files.map(file => `${file.size}:${file.mtimeMs}`).join(',');
  const url = new URL(`http://localhost/${name}.packed`);
  url.searchParams.set('source', key);
  const result = await cachedResponse(url, 30 * day, async () => {
    const packed = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./pack-dem.mjs', import.meta.url), {workerData: name});
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => {
        if (code) reject(new Error('Could not prepare the polar terrain.'));
      });
    });
    return new Response(packed);
  });
  return result.body;
}

function getPolarAsset(name) {
  if (!polarAssets.has(name)) {
    const task = preparePolarAsset(name).catch(error => { polarAssets.delete(name); throw error; });
    polarAssets.set(name, task);
  }
  return polarAssets.get(name);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const api = routes.get(url.pathname);
    if (api) {
      const [handler, lifetime] = api;
      const result = await cachedResponse(url, lifetime, () => handler(url));
      res.writeHead(result.status, {...result.headers, 'X-Lunar-Cache': result.cache});
      res.end(result.body);
      return;
    }
    const polarAsset = polarRoutes.get(url.pathname);
    if (polarAsset) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(await getPolarAsset(polarAsset));
      return;
    }
    const path = url.pathname === '/' ? 'src/index.html'
      : url.pathname === '/three.js' ? 'assets/three.js'
      : /\.(bin|json)$/.test(url.pathname) ? 'data' + url.pathname : 'src' + url.pathname;
    if (path.includes('..') || !existsSync(path)) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.setHeader('Content-Type', types[path.split('.').pop()] || 'text/plain');
    createReadStream(path).pipe(res);
  } catch (error) {
    res.writeHead(502, {'Content-Type': 'application/json'}).end(JSON.stringify({error: error.message}));
  }
});
const arg = process.argv.indexOf('--port');
const port = Number(process.env.PORT || (arg >= 0 ? process.argv[arg + 1] : 3000));
server.listen(port, '0.0.0.0', () => console.log('Lunar Horizon on ' + port));
