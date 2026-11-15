export const MOON_CONFIG = {
  RADIUS: 1.0,
  RADIUS_KM: 1737.4,
  RADIUS_METERS: 1737400,
  SEGMENTS: 64,
  BUMP_SCALE: 0.015,
  HORIZON_THRESHOLD: 0.0045,
};

export const EARTH_CONFIG = {
  RADIUS_KM: 6371.0,
  RADIUS_RATIO: 6371.0 / MOON_CONFIG.RADIUS_KM, // ≈ 3.667
  RADIUS: MOON_CONFIG.RADIUS * (6371.0 / MOON_CONFIG.RADIUS_KM),
  AXIAL_TILT_DEG: 23.44,
  SEGMENTS: 96,
  ATMO_SCALE: 1.03,
  CLOUD_SCALE: 1.007,
  CISLUNAR_DISTANCE: 15 * MOON_CONFIG.RADIUS,
  DAY_LOCAL_URL: '/earth/earth_day_4096.jpg',
  DAY_REMOTE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_day_4096.jpg',
  NIGHT_LOCAL_URL: '/earth/earth_night_4096.jpg',
  NIGHT_REMOTE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_night_4096.jpg',
  NORMAL_LOCAL_URL: '/earth/earth_normal_2048.jpg',
  NORMAL_REMOTE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_normal_2048.jpg',
  SPECULAR_LOCAL_URL: '/earth/earth_specular_2048.jpg',
  SPECULAR_REMOTE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg',
  CLOUDS_LOCAL_URL: '/earth/earth_clouds_1024.png',
  CLOUDS_REMOTE_URL:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_clouds_1024.png',
};

export const VIEW_MODES = {
  LUNAR: 'LUNAR',
  CISLUNAR: 'CISLUNAR',
};

export const TRAJECTORY_CONFIG = {
  FORMAT: 'lwp-trajectory/1',
  DEFAULT_URL: '/trajectories/trajectory-2026-11-15T121332Z.json',
  DEFAULT_PLAYBACK_DURATION_SEC: 28,
  NEAR_EARTH_SOLID_RADIUS_MULT: 3.5,
  NEAR_MOON_SOLID_RADIUS_MULT: 7.0,
  COMPRESSED_DASH_SIZE: 0.42,
  COMPRESSED_GAP_SIZE: 0.32,
  MOON_ORBIT_ARC: {
    color: 0x94a3b8,
    lineWidth: 1.6,
    opacity: 0.45,
    dashSize: 0.28,
    gapSize: 0.22,
  },
  PHASES: {
    ascent: { label: 'Ascent', color: 0xfb923c, css: '#fb923c', lineWidth: 2.8, opacity: 0.96 },
    parking_orbit: { label: 'Parking Orbit', color: 0x38bdf8, css: '#38bdf8', lineWidth: 2.4, opacity: 0.88 },
    transfer: { label: 'Direct Transfer', color: 0x34d399, css: '#34d399', lineWidth: 3.1, opacity: 0.96 },
    lunar_orbit: { label: 'Lunar Orbit', color: 0xc084fc, css: '#c084fc', lineWidth: 2.5, opacity: 0.9 },
    descent_coast: { label: 'Descent Coast', color: 0xf472b6, css: '#f472b6', lineWidth: 2.7, opacity: 0.94 },
    braking: { label: 'Powered Braking', color: 0xf87171, css: '#f87171', lineWidth: 3.0, opacity: 0.98 },
    terminal: { label: 'Terminal Descent', color: 0xfacc15, css: '#facc15', lineWidth: 3.0, opacity: 1.0 },
  },
  MAJOR_EVENTS: new Set(['launch', 'tli', 'loi', 'doi', 'touchdown']),
};

export const LOD_CONFIG = {
  MIN_ZOOM: 2,
  MAX_ZOOM: 12,
  TILE_SIZE_PX: 256,
  DEFAULT_LAYER: 'LRO_WAC_LOCAL',
  CACHE_SIZE: 1536,
  MAX_CONCURRENT_REQUESTS: 12,
  MAX_LOCAL_CONCURRENT_REQUESTS: 24,
  SPLIT_THRESHOLD: 3.0,
  EDGE_SPLIT_ATTENUATION: 0.4,
  STALE_INFLIGHT_FRAMES: 3,
  HIGH_LOD_MAX_CAMERA_DISTANCE: 3 * MOON_CONFIG.RADIUS,
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

const KAGUYA_TC_WMTS_URL =
  'https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd/1.0.0/default/default028mm/{z}/{y}/{x}.png';
const KAGUYA_TC_USGS_WMS_URL =
  'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/earth/moon_simp_cyl.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=KaguyaTC_Ortho&STYLES=&SRS=EPSG:4326&BBOX={bbox}&WIDTH=256&HEIGHT=256&FORMAT=image/png';

export const MAP_LAYERS = {
  LRO_WAC_LOCAL: {
    id: 'LRO_WAC_LOCAL',
    name: 'Local LRO WAC (Z2–Z8) + Kaguya TC (Z9–Z12)',
    // Pre-downloaded local tiles for Z2–Z8 (up to 83 m/pixel)
    url: '/tiles/lro_wac/{z}/{x}/{y}.jpg',
    fallbackUrl:
      'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    isWebMercatorQuad: false,
    baseMaxZoom: 8,
    maxZoom: 12,
    overlays: [
      {
        id: 'KAGUYA_TC_ORTHO_WMTS',
        name: 'NASA Moon Trek Kaguya TC Ortho 4096ppd (Z9–Z10)',
        url: KAGUYA_TC_WMTS_URL,
        fallbackUrl: KAGUYA_TC_USGS_WMS_URL,
        isWebMercatorQuad: false,
        isTransparent: false,
        minZoom: 9,
        maxZoom: 10,
      },
      {
        id: 'KAGUYA_TC_ORTHO_WMS',
        name: 'USGS Kaguya TC Ortho 4096ppd (Z11–Z12)',
        url: KAGUYA_TC_USGS_WMS_URL,
        isWebMercatorQuad: false,
        isTransparent: false,
        minZoom: 11,
        maxZoom: 12,
      },
    ],
  },
  KAGUYA_TC_GLOBAL: {
    id: 'KAGUYA_TC_GLOBAL',
    name: 'Global Kaguya TC Ortho 4096ppd (Z2–Z12)',
    url: KAGUYA_TC_WMTS_URL,
    fallbackUrl: KAGUYA_TC_USGS_WMS_URL,
    isWebMercatorQuad: false,
    baseMaxZoom: 10,
    maxZoom: 12,
    overlays: [
      {
        id: 'KAGUYA_TC_ORTHO_WMS',
        name: 'USGS Kaguya TC Ortho 4096ppd (Z11–Z12)',
        url: KAGUYA_TC_USGS_WMS_URL,
        isWebMercatorQuad: false,
        isTransparent: false,
        minZoom: 11,
        maxZoom: 12,
      },
    ],
  },
};

export const CELESTIAL_CONFIG = {
  EARTH_DISTANCE: 221.2,
  EARTH_RADIUS: EARTH_CONFIG.RADIUS,
  EARTH_AXIAL_TILT_DEG: EARTH_CONFIG.AXIAL_TILT_DEG,
  SUN_DISTANCE: 420.0,
  SUN_RADIUS: 4.2,
  SOLAR_CONSTANT_WM2: 1361.0,
  STAR_COUNT: 6000,
  STARFIELD_RADIUS: 850.0,
};

export const STARMAP_CONFIG = {
  MILKYWAY_LOCAL_URL: '/stars/gaia_edr3_4k.png',
  MILKYWAY_REMOTE_URL:
    'https://sci.esa.int/documents/33580/35361/Gaia_EDR3_flux_cartesian_4k.png/4648ec09-6c63-47a5-d0da-3ab3e0b42afe?version=1.0&t=1606986362680&download=true',
  MILKYWAY_INTENSITY: 0.35,
  CATALOG_LOCAL_URL: '/stars/stars.8.json',
  CATALOG_REMOTE_URL:
    'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/stars.8.json',
  MAX_MAGNITUDE: 6.2,
  ECLIPTIC_OBLIQUITY_DEG: 23.44,
};

export const HORIZONS_CONFIG = {
  PROXY_ENDPOINT: PROXY_CONFIG.HORIZONS_API_PATH,
  COMMAND: "'301'",
  CENTER: "'500@301'",
  QUANTITIES: "'14,15'",
};
