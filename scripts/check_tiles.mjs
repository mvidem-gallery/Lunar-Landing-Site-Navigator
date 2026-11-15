// Запуск: node scripts/check_tiles.mjs
const SOURCES = [
  {
    name: 'NASA Moon Trek LRO WAC 303ppd (Z2–Z8)',
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    minZoom: 2,
    maxZoom: 8,
  },
  {
    name: 'NASA Moon Trek Kaguya TC Ortho 4096ppd (Z2–Z10)',
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd/1.0.0/default/default028mm/{z}/{y}/{x}.png',
    minZoom: 2,
    maxZoom: 10,
  },
  {
    name: 'USGS Astrogeology WMS Kaguya TC Ortho 4096ppd (Z11–Z12)',
    url: 'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/earth/moon_simp_cyl.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=KaguyaTC_Ortho&STYLES=&SRS=EPSG:4326&BBOX={bbox}&WIDTH=256&HEIGHT=256&FORMAT=image/png',
    minZoom: 11,
    maxZoom: 12,
  },
];

// Контрольні точки: екватор видимого боку, зворотний бік, приполярна зона
const PROBES = [
  { label: '0°E, 0°N (Центр)', lon: 0, lat: 0 },
  { label: '180°E, 0°N (Зворотний бік)', lon: 180, lat: 0 },
  { label: '0°E, 75°N (Північ)', lon: 0, lat: 75 },
];

function lonLatToTile(lon, lat, z) {
  const cols = Math.pow(2, z + 1);
  const rows = Math.pow(2, z);

  const x = Math.min(cols - 1, Math.max(0, Math.floor(((lon + 180) / 360) * cols)));
  const y = Math.min(rows - 1, Math.max(0, Math.floor(((90 - lat) / 180) * rows)));

  const lonStart = -180 + (x / cols) * 360;
  const lonEnd = -180 + ((x + 1) / cols) * 360;
  const latStart = 90 - ((y + 1) / rows) * 180;
  const latEnd = 90 - (y / rows) * 180;

  return { x, y, bbox: `${lonStart},${latStart},${lonEnd},${latEnd}` };
}

async function probeSources() {
  for (const src of SOURCES) {
    console.log(`\n=== Перевірка: ${src.name} ===`);
    for (let z = src.minZoom; z <= src.maxZoom; z++) {
      const results = await Promise.all(
        PROBES.map(async (p) => {
          const { x, y, bbox } = lonLatToTile(p.lon, p.lat, z);
          const targetUrl = src.url
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y)
            .replace('{bbox}', bbox);

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
