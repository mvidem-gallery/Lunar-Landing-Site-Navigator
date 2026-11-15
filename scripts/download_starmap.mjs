import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { STARMAP_CONFIG } from '../src/config/constants.js';

const OUTPUT_DIR = path.resolve('public/stars');
const USER_AGENT = 'LunarSurfaceExplorer/1.0 (https://github.com/astronexus)';

const ASSETS = [
  {
    name: 'ESA Gaia EDR3 All-Sky Colour Map (4000×2000 PNG)',
    url: STARMAP_CONFIG.MILKYWAY_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'gaia_edr3_4k.png'),
    minBytes: 5_000_000,
  },
  {
    name: 'Hipparcos/Tycho Зоряний каталог (mag <= 8.0)',
    url: STARMAP_CONFIG.CATALOG_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'stars.8.json'),
    minBytes: 100_000,
  },
];

async function downloadAsset(asset, retries = 3) {
  if (fs.existsSync(asset.targetPath)) {
    const stat = await fs.promises.stat(asset.targetPath);
    if (stat.size >= asset.minBytes) {
      console.log(`[SKIP] ${asset.name} вже існує (${(stat.size / 1024).toFixed(1)} KB)`);
      return;
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[GET ] ${asset.name} (спроба ${attempt}/${retries})...`);
      const res = await fetch(asset.url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      await fs.promises.mkdir(path.dirname(asset.targetPath), { recursive: true });
      const tempPath = `${asset.targetPath}.tmp`;
      await pipeline(res.body, fs.createWriteStream(tempPath));

      const stat = await fs.promises.stat(tempPath);
      if (stat.size < asset.minBytes) {
        await fs.promises.unlink(tempPath);
        throw new Error(`Файл занадто малий (${stat.size} байт)`);
      }

      await fs.promises.rename(tempPath, asset.targetPath);
      console.log(`[ OK ] Збережено ${path.relative(process.cwd(), asset.targetPath)} (${(stat.size / 1024).toFixed(1)} KB)`);
      return;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`Не вдалося завантажити "${asset.name}": ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function main() {
  console.log(`Цільова директорія зоряної карти: ${OUTPUT_DIR}\n`);
  for (const asset of ASSETS) {
    await downloadAsset(asset);
  }
  console.log('\nГотово! Усі ресурси зоряної карти завантажено.');
}

main().catch((err) => {
  console.error('\nПомилка:', err.message);
  process.exitCode = 1;
});
