import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { terrainDetail } from '../src/lunar-horizon/server.js';
import { NASA_MOON_EXPLORATION_SITES } from '../src/data/lunarLandingSites.js';

const LOLA64_URL =
  'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img';
const LOLA64_BYTES = 23040 * 11520 * 2;
const CACHE_ROOT = path.resolve('cache/lunar-dem');
const LDEM64_PATH = path.join(CACHE_ROOT, 'ldem_64.img');

async function downloadGlobalLdem64() {
  if (fs.existsSync(LDEM64_PATH)) {
    const stat = await fsp.stat(LDEM64_PATH);
    if (stat.size === LOLA64_BYTES) {
      console.log(`[SKIP] ldem_64.img вже завантажено (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`);
      return;
    }
  }

  await fsp.mkdir(CACHE_ROOT, { recursive: true });
  const tmpPath = `${LDEM64_PATH}.tmp`;
  console.log(`[GET ] NASA LOLA ldem_64.img (~${(LOLA64_BYTES / (1024 * 1024)).toFixed(1)} MB, 474 м/пікс)...`);

  const res = await fetch(LOLA64_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  let downloaded = 0;
  let lastLog = 0;
  const startTime = Date.now();

  const progress = new Transform({
    transform(chunk, _enc, cb) {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastLog > 500 || downloaded === LOLA64_BYTES) {
        const pct = ((downloaded / LOLA64_BYTES) * 100).toFixed(1);
        const mb = (downloaded / (1024 * 1024)).toFixed(1);
        const totalMb = (LOLA64_BYTES / (1024 * 1024)).toFixed(1);
        const mbps = (downloaded / (1024 * 1024) / Math.max(0.5, (now - startTime) / 1000)).toFixed(2);
        process.stdout.write(`\r[${pct}%] ${mb} / ${totalMb} MB (${mbps} MB/s)   `);
        lastLog = now;
      }
      cb(null, chunk);
    },
  });

  await pipeline(res.body, progress, fs.createWriteStream(tmpPath));
  const stat = await fsp.stat(tmpPath);
  if (stat.size !== LOLA64_BYTES) {
    await fsp.unlink(tmpPath);
    throw new Error(`Очікувалося ${LOLA64_BYTES} байт, отримано ${stat.size} байт`);
  }

  await fsp.rename(tmpPath, LDEM64_PATH);
  console.log(`\n[ OK ] Збережено ${path.relative(process.cwd(), LDEM64_PATH)}`);
}

async function prefetchPoint(lat, lon, label = '') {
  const details = ['regional', 'fine', Math.abs(lat) <= 59.3 ? 'stereo' : 'landing'];
  console.log(`[PREFETCH] ${label || `${lat.toFixed(3)}, ${lon.toFixed(3)}`}...`);
  for (const detail of details) {
    const query = new URLSearchParams({ lat: lat.toFixed(3), lon: lon.toFixed(3) });
    if (detail !== 'regional') query.set('detail', detail);
    try {
      const res = await terrainDetail(new URL(`http://localhost/api/terrain-detail?${query}`));
      console.log(`  - ${detail}: status ${res.status}`);
    } catch (err) {
      console.warn(`  - ${detail}: ${err.message}`);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const latIdx = process.argv.indexOf('--lat');
  const lonIdx = process.argv.indexOf('--lon');

  if (latIdx >= 0 && lonIdx >= 0) {
    const lat = Number(process.argv[latIdx + 1]);
    const lon = Number(process.argv[lonIdx + 1]);
    await prefetchPoint(lat, lon, `Custom (${lat}, ${lon})`);
    return;
  }

  if (args.has('--sites')) {
    await downloadGlobalLdem64();
    for (const site of NASA_MOON_EXPLORATION_SITES) {
      await prefetchPoint(site.lat, site.lon, site.name);
    }
    return;
  }

  // За замовчуванням завантажуємо глобальну карту LOLA 64ppd (474м)
  await downloadGlobalLdem64();
  console.log('\nПідказка: для попереднього кешування детальних точок посадки (SLDEM2015 / LOLA 30m) запустіть:');
  console.log('  node scripts/download_lunar_dem.mjs --sites');
  console.log('  node scripts/download_lunar_dem.mjs --lat 18.925 --lon 172.089');
}

main().catch((err) => {
  console.error('\nПомилка:', err.message);
  process.exitCode = 1;
});
