import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EARTH_CONFIG } from '../src/config/constants.js';

const OUTPUT_DIR = path.resolve('public/earth');
const USER_AGENT = 'LunarSurfaceExplorer/1.0';

const ASSETS = [
  {
    name: 'NASA Blue Marble Day Map (4096×2048)',
    url: EARTH_CONFIG.DAY_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'earth_day_4096.jpg'),
    minBytes: 100_000,
  },
  {
    name: 'NASA Black Marble Night City Lights (4096×2048)',
    url: EARTH_CONFIG.NIGHT_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'earth_night_4096.jpg'),
    minBytes: 50_000,
  },
  {
    name: 'Earth Topography Normal Map (2048×1024)',
    url: EARTH_CONFIG.NORMAL_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'earth_normal_2048.jpg'),
    minBytes: 50_000,
  },
  {
    name: 'Earth Ocean Specular Mask (2048×1024)',
    url: EARTH_CONFIG.SPECULAR_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'earth_specular_2048.jpg'),
    minBytes: 50_000,
  },
  {
    name: 'Earth Cloud Cover Map (1024×512)',
    url: EARTH_CONFIG.CLOUDS_REMOTE_URL,
    targetPath: path.join(OUTPUT_DIR, 'earth_clouds_1024.png'),
    minBytes: 50_000,
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
      console.log(
        `[ OK ] Збережено ${path.relative(process.cwd(), asset.targetPath)} (${(stat.size / 1024).toFixed(1)} KB)`
      );
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
  console.log(`Цільова директорія текстур Землі: ${OUTPUT_DIR}\n`);
  for (const asset of ASSETS) {
    await downloadAsset(asset);
  }
  console.log('\nГотово! Усі текстури реальної Землі завантажено.');
}

main().catch((err) => {
  console.error('\nПомилка:', err.message);
  process.exitCode = 1;
});
