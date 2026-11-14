// Запуск: node check_tiles.mjs
const SOURCES = [
  {
    name: 'OpenPlanetary LRO (TMS)',
    url: 'https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo/{z}/{x}/{y}.png',
    isWebMercatorQuad: true,
  },
  {
    name: 'NASA Moon Trek LRO WAC (Equirectangular)',
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
  },
];

// Контрольні точки: екватор видимого боку, зворотний бік, приполярна зона
const PROBES = [
  { label: '0°E, 0°N (Центр)', lon: 0, lat: 0 },
  { label: '180°E, 0°N (Зворотний бік)', lon: 180, lat: 0 },
  { label: '0°E, 75°N (Північ)', lon: 0, lat: 75 },
];

function lonLatToTile(lon, lat, z, isWebMercatorQuad) {
  const cols = isWebMercatorQuad ? Math.pow(2, z) : Math.pow(2, z + 1);
  const rows = Math.pow(2, z);

  const x = Math.min(cols - 1, Math.max(0, Math.floor(((lon + 180) / 360) * cols)));
  let y = Math.min(rows - 1, Math.max(0, Math.floor(((90 - lat) / 180) * rows)));

  if (isWebMercatorQuad) {
    y = rows - 1 - y; // Інверсія TMS
  }
  return { x, y };
}

async function probeSources() {
  for (const src of SOURCES) {
    console.log(`\n=== Перевірка: ${src.name} ===`);
    for (let z = 2; z <= 11; z++) {
      const results = await Promise.all(
        PROBES.map(async (p) => {
          const { x, y } = lonLatToTile(p.lon, p.lat, z, src.isWebMercatorQuad);
          const targetUrl = src.url
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y);

          try {
            const res = await fetch(targetUrl, { method: 'HEAD' });
            const sizeKb = res.headers.get('content-length')
              ? `${(Number(res.headers.get('content-length')) / 1024).toFixed(1)}KB`
              : '?';
            return `${p.label}: ${res.ok ? `OK (${sizeKb})` : `HTTP ${res.status}`}`;
          } catch (err) {
            return `${p.label}: ERR (${err.message})`;
          }
        })
      );
      console.log(`Z${z.toString().padStart(2, '0')} -> ${results.join(' | ')}`);
    }
  }
}

probeSources();