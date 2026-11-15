export const MOON_CONFIG = {
  RADIUS: 1.0,
  SEGMENTS: 64,
  BUMP_SCALE: 0.015,
};

export const LOD_CONFIG = {
  MIN_ZOOM: 2,
  MAX_ZOOM: 12,
  DEFAULT_LAYER: 'LRO_WAC_LOCAL',
  CACHE_SIZE: 1024,
  MAX_CONCURRENT_REQUESTS: 16,
  SPLIT_THRESHOLD: 1.35,
};

export const MAP_LAYERS = {
  LRO_WAC_LOCAL: {
    id: 'LRO_WAC_LOCAL',
    name: 'Локальна LRO WAC (Z2–Z8) + Kaguya TC (Z9–Z12)',
    // Завантажені локальні тайли для рівнів Z2–Z8 (до 83 м/піксель)
    url: '/tiles/lro_wac/{z}/{x}/{y}.jpg',
    fallbackUrl:
      'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
    baseMaxZoom: 8,
    maxZoom: 12,
    overlays: [
      {
        id: 'OPM_LRO_GLOBAL_HD',
        name: 'Глобальна LRO / Kaguya HD (Z9–Z11)',
        url: 'https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo/{z}/{x}/{y}.png',
        isWebMercatorQuad: true,
        minZoom: 9,
        maxZoom: 11,
        bounds: { minLon: -180, maxLon: 180, minLat: -85, maxLat: 85 },
      },
    ],
  },
};

export const CELESTIAL_CONFIG = {
  EARTH_DISTANCE: 120.0,
  EARTH_RADIUS: 2.0,
  EARTH_TEXTURE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
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