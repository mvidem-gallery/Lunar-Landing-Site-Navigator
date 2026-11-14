export const MOON_CONFIG = {
  RADIUS: 1.0,
  SEGMENTS: 64,
  BUMP_SCALE: 0.015,
};

export const LOD_CONFIG = {
  MIN_ZOOM: 2,
  MAX_ZOOM: 16,
  DEFAULT_LAYER: 'LRO_HYBRID_LOCAL_BASE',
  CACHE_SIZE: 1024,
  MAX_CONCURRENT_REQUESTS: 16,
  SPLIT_THRESHOLD: 1.35,
};

export const MAP_LAYERS = {
  LRO_HYBRID_LOCAL_BASE: {
    id: 'LRO_HYBRID_LOCAL_BASE',
    name: 'Гібридна: Локальна LRO WAC (Z2–Z8) + Мережеві HD/NAC (Z9–Z16)',
    // Локальні завантажені тайли для рівнів Z2–Z8 (до 83 м/пікс)
    url: '/tiles/lro_wac/{z}/{x}/{y}.jpg',
    fallbackUrl:
      'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
    baseMaxZoom: 8,
    maxZoom: 16,
    // Мережеві шари високої роздільної здатності, що підвантажуються при наближенні на Z9+
    overlays: [
      {
        id: 'APOLLO_11_NAC',
        name: 'Apollo 11 (Море Спокою — NAC HD)',
        url: 'https://trek.nasa.gov/tiles/Moon/EQ/Apollo11_NAC_Mosaic/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
        isWebMercatorQuad: false,
        minZoom: 9,
        maxZoom: 16,
        bounds: { minLon: 22.8, maxLon: 24.2, minLat: 0.1, maxLat: 1.3 },
      },
      {
        id: 'TYCHO_CRATER_NAC',
        name: 'Кратер Тіхо (Центральна гірка — NAC HD)',
        url: 'https://trek.nasa.gov/tiles/Moon/EQ/Tycho_NAC_Mosaic/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
        isWebMercatorQuad: false,
        minZoom: 9,
        maxZoom: 16,
        bounds: { minLon: -12.5, maxLon: -10.0, minLat: -44.2, maxLat: -42.4 },
      },
      {
        id: 'COPERNICUS_NAC',
        name: 'Кратер Коперник (NAC HD)',
        url: 'https://trek.nasa.gov/tiles/Moon/EQ/Copernicus_NAC_Mosaic/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
        isWebMercatorQuad: false,
        minZoom: 9,
        maxZoom: 16,
        bounds: { minLon: -21.2, maxLon: -18.8, minLat: 8.8, maxLat: 10.6 },
      },
      {
        id: 'KAGUYA_TC_GLOBAL_HD',
        name: 'Глобальна мозаїка Kaguya TC (~10 м/пікс, Z9–Z12)',
        url: 'https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TC_Ortho_Global_4096ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
        isWebMercatorQuad: false,
        minZoom: 9,
        maxZoom: 12,
        bounds: { minLon: -180, maxLon: 180, minLat: -65, maxLat: 65 },
      },
    ],
  },

  LRO_WAC_LOCAL: {
    id: 'LRO_WAC_LOCAL',
    name: 'Тільки локальна: LRO WAC Калібрована (Z2–Z8)',
    url: '/tiles/lro_wac/{z}/{x}/{y}.jpg',
    fallbackUrl:
      'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
    baseMaxZoom: 8,
    maxZoom: 8,
    overlays: [],
  },

  LRO_WAC_ONLINE: {
    id: 'LRO_WAC_ONLINE',
    name: 'Онлайн: NASA Moon Trek LRO WAC (Z2–Z8)',
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
    baseMaxZoom: 8,
    maxZoom: 8,
    overlays: [],
  },
};

export const CELESTIAL_CONFIG = {
  EARTH_DISTANCE: 120.0,
  EARTH_RADIUS: 2.0,
  EARTH_TEXTURE_URL: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
  SUN_DISTANCE: 400.0,
  SUN_RADIUS: 3.5,
  STAR_COUNT: 6000,
  STARFIELD_RADIUS: 600.0,
};

export const HORIZONS_CONFIG = {
  PROXY_ENDPOINT: '/api/horizons',
  COMMAND: "'301'",
  CENTER: "'500@301'",
  QUANTITIES: "'14,15'",
};