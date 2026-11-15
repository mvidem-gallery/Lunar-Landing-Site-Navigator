export const MOON_CONFIG = {
  RADIUS: 1.0,
  RADIUS_KM: 1737.4,
  RADIUS_METERS: 1737400,
  SEGMENTS: 64,
  BUMP_SCALE: 0.015,
  HORIZON_THRESHOLD: 0.0045,
};

export const LOD_CONFIG = {
  MIN_ZOOM: 2,
  MAX_ZOOM: 12,
  TILE_SIZE_PX: 256,
  DEFAULT_LAYER: 'LRO_WAC_LOCAL',
  CACHE_SIZE: 1024,
  MAX_CONCURRENT_REQUESTS: 16,
  SPLIT_THRESHOLD: 1.35,
};

export const OVERLAY_CONFIG = {
  HEATMAP_OPACITY: 0.65,
  GRID_DEFAULT_STEP_DEG: 15.0,
  GRID_DEFAULT_SUB_STEP_DEG: 5.0,
  GRID_DEFAULT_OPACITY: 0.65,
};

export const PROXY_CONFIG = {
  OPM_TILES_PATH: '/opm-tiles',
  OPM_TILES_TARGET: 'https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo',
  HORIZONS_API_PATH: '/api/horizons',
  HORIZONS_API_TARGET: 'https://ssd.jpl.nasa.gov',
  HORIZONS_API_REWRITE_PATH: '/api/horizons.api',
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
        url: `${PROXY_CONFIG.OPM_TILES_PATH}/{z}/{x}/{y}.png`,
        fallbackUrl: `${PROXY_CONFIG.OPM_TILES_TARGET}/{z}/{x}/{y}.png`,
        isWebMercatorQuad: true,
        isTms: true,
        minZoom: 9,
        maxZoom: 11,
        bounds: { minLon: -180, maxLon: 180, minLat: -85, maxLat: 85 },
      },
    ],
  },
};

export const CELESTIAL_CONFIG = {
  EARTH_DISTANCE: 221.2,
  EARTH_RADIUS: 3.667,
  EARTH_AXIAL_TILT_DEG: 23.44,
  SUN_DISTANCE: 420.0,
  SUN_RADIUS: 4.2,
  SOLAR_CONSTANT_WM2: 1361.0,
  STAR_COUNT: 6000,
  STARFIELD_RADIUS: 850.0,
};

export const STARMAP_CONFIG = {
  MILKYWAY_LOCAL_URL: '/stars/milkyway_4k.jpg',
  MILKYWAY_REMOTE_URL:
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/Deep_Star_Maps_2020_%E2%80%93_Milkyway_2020_64k.jpg/3840px-Deep_Star_Maps_2020_%E2%80%93_Milkyway_2020_64k.jpg',
  MILKYWAY_INTENSITY: 0.62,
  CATALOG_LOCAL_URL: '/stars/stars.8.json',
  CATALOG_REMOTE_URL:
    'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/stars.8.json',
  MAX_MAGNITUDE: 8.0,
  ECLIPTIC_OBLIQUITY_DEG: 23.44,
};

export const HORIZONS_CONFIG = {
  PROXY_ENDPOINT: PROXY_CONFIG.HORIZONS_API_PATH,
  COMMAND: "'301'",
  CENTER: "'500@301'",
  QUANTITIES: "'14,15'",
};
