import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONFIG = {
  urlTemplate:
    'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
  outputDir: path.resolve('public/tiles/lro_wac'),
  minZoom: 2,
  maxZoom: 8,
  concurrency: 24,
  retries: 4,
};

function getTotalTilesCount(minZ, maxZ) {
  let total = 0;
  for (let z = minZ; z <= maxZ; z++) {
    const cols = Math.pow(2, z + 1);
    const rows = Math.pow(2, z);
    total += cols * rows;
  }
  return total;
}

function* tileGenerator() {
  for (let z = CONFIG.minZoom; z <= CONFIG.maxZoom; z++) {
    const cols = Math.pow(2, z + 1);
    const rows = Math.pow(2, z);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        yield { z, x, y };
      }
    }
  }
}

async function downloadTile({ z, x, y }) {
  const filePath = path.join(CONFIG.outputDir, String(z), String(x), `${y}.jpg`);

  if (fs.existsSync(filePath)) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 500) return 'skipped';
  }

  const url = CONFIG.urlTemplate
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);

  for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await pipeline(res.body, fs.createWriteStream(filePath));
      return 'downloaded';
    } catch {
      if (attempt === CONFIG.retries) return 'failed';
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

async function main() {
  const totalTiles = getTotalTilesCount(CONFIG.minZoom, CONFIG.maxZoom);
  console.log(`Старт завантаження LRO WAC (Z${CONFIG.minZoom}–Z${CONFIG.maxZoom})`);
  console.log(`Цільова директорія: ${CONFIG.outputDir}`);
  console.log(`Всього тайлів: ${totalTiles}\n`);

  const iterator = tileGenerator();
  const stats = { downloaded: 0, skipped: 0, failed: 0 };
  const startTime = Date.now();

  const worker = async () => {
    for (const task of iterator) {
      const status = await downloadTile(task);
      stats[status]++;

      const processed = stats.downloaded + stats.skipped + stats.failed;
      if (processed % 250 === 0 || processed === totalTiles) {
        const pct = ((processed / totalTiles) * 100).toFixed(2);
        const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
        const speed = (stats.downloaded / elapsedSec).toFixed(1);
        process.stdout.write(
          `\r[${pct}%] ${processed}/${totalTiles} | Завант: ${stats.downloaded} (${speed} тайл/с) | Пропущ: ${stats.skipped} | Помилки: ${stats.failed}`
        );
      }
    }
  };

  await Promise.all(Array.from({ length: CONFIG.concurrency }, () => worker()));
  console.log('\n\nГотово:', stats);
}

main();