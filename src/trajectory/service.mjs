import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const LWP_DIR = path.join(
  PROJECT_ROOT,
  'trajectory',
  'Lunar-Window-Navigator',
  'launch-window-prediction'
);
export const DEFAULT_JOBS_DIR = path.join(LWP_DIR, 'jobs');
export const GENERATED_TRANSFER_CONFIG_DIR = path.join(os.tmpdir(), 'nasa-lunar-lwp-configs');

export const LANDING_WINDOW_PRESETS = Object.freeze({
  flexible: Object.freeze({
    require_sun_visible: false,
    sun_elevation_min_deg: 0.0,
    sun_elevation_max_deg: 90.0,
    require_earth_visible: false,
    max_wait_in_orbit_h: 48.0,
  }),
  daylight: Object.freeze({
    require_sun_visible: true,
    sun_elevation_min_deg: 0.0,
    sun_elevation_max_deg: 90.0,
    require_earth_visible: false,
    max_wait_in_orbit_h: 48.0,
  }),
  daylight_earth: Object.freeze({
    require_sun_visible: true,
    sun_elevation_min_deg: 0.0,
    sun_elevation_max_deg: 90.0,
    require_earth_visible: true,
    max_wait_in_orbit_h: 48.0,
  }),
  artemis: Object.freeze({
    require_sun_visible: true,
    sun_elevation_min_deg: 0.0,
    sun_elevation_max_deg: 20.0,
    require_earth_visible: true,
    max_wait_in_orbit_h: 48.0,
  }),
});

const IS_WINDOWS = process.platform === 'win32';
const BIN_NAME = IS_WINDOWS ? 'launch-window-prediction.exe' : 'launch-window-prediction';
const CARGO_BIN_NAME = IS_WINDOWS ? 'cargo.exe' : 'cargo';

export class TrajectoryServiceError extends Error {
  constructor(message, { statusCode = 500, code = 'internal', details = null } = {}) {
    super(message);
    this.name = 'TrajectoryServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function findExecutableOnPath(exeName) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exeName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore unreadable PATH entries
    }
  }
  return null;
}

export function resolveLwpRunner() {
  const envBin = process.env.LWP_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return {
      cmd: envBin,
      baseArgs: [],
      cwd: LWP_DIR,
      mode: 'env',
    };
  }

  const releaseBin = path.join(LWP_DIR, 'target', 'release', BIN_NAME);
  if (fs.existsSync(releaseBin)) {
    return {
      cmd: releaseBin,
      baseArgs: [],
      cwd: LWP_DIR,
      mode: 'release',
    };
  }

  const debugBin = path.join(LWP_DIR, 'target', 'debug', BIN_NAME);
  if (fs.existsSync(debugBin)) {
    return {
      cmd: debugBin,
      baseArgs: [],
      cwd: LWP_DIR,
      mode: 'debug',
    };
  }

  const pathBin = findExecutableOnPath(BIN_NAME);
  if (pathBin) {
    return {
      cmd: pathBin,
      baseArgs: [],
      cwd: LWP_DIR,
      mode: 'path',
    };
  }

  const homeCargo = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cargo',
    'bin',
    CARGO_BIN_NAME
  );
  const cargoCmd =
    (homeCargo && fs.existsSync(homeCargo) ? homeCargo : null) ||
    findExecutableOnPath(CARGO_BIN_NAME);
  if (cargoCmd && fs.existsSync(path.join(LWP_DIR, 'Cargo.toml'))) {
    return {
      cmd: cargoCmd,
      baseArgs: ['run', '--quiet', '--release', '--'],
      cwd: LWP_DIR,
      mode: 'cargo',
    };
  }

  return null;
}

function stripTomlComment(line) {
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quoteChar) {
        inQuotes = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuotes = true;
        quoteChar = ch;
      } else if (ch === '#') {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

function parseSimpleTomlValue(raw) {
  const s = raw.trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((part) => parseSimpleTomlValue(part))
      .filter((v) => v !== '');
  }
  const num = Number(s);
  if (Number.isFinite(num)) return num;
  return s;
}

function parseTomlArrayTables(text, tableName) {
  const items = [];
  let current = null;
  let inSubTable = false;
  const headerPrefix = `[[${tableName}]]`;

  for (const rawLine of text.split(/\r?\n/)) {
    const clean = stripTomlComment(rawLine).trim();
    if (!clean) continue;

    if (clean === headerPrefix) {
      if (current) items.push(current);
      current = {};
      inSubTable = false;
      continue;
    }

    if (clean.startsWith('[')) {
      inSubTable = true;
      continue;
    }

    if (!current || inSubTable) continue;
    const eqIdx = clean.indexOf('=');
    if (eqIdx === -1) continue;
    const key = clean.slice(0, eqIdx).trim();
    const val = parseSimpleTomlValue(clean.slice(eqIdx + 1));
    current[key] = val;
  }

  if (current) items.push(current);
  return items;
}

function loadCustomTomlEntries(customDir, isPresetKind = false) {
  if (!fs.existsSync(customDir)) return [];
  const out = [];
  for (const file of fs.readdirSync(customDir)) {
    if (!file.endsWith('.toml')) continue;
    try {
      const id = path.basename(file, '.toml');
      const text = fs.readFileSync(path.join(customDir, file), 'utf8');
      const obj = { id, is_preset: false };
      let inSubTable = false;
      for (const rawLine of text.split(/\r?\n/)) {
        const clean = stripTomlComment(rawLine).trim();
        if (!clean) continue;
        if (clean.startsWith('[')) {
          inSubTable = true;
          continue;
        }
        if (inSubTable) continue;
        const eqIdx = clean.indexOf('=');
        if (eqIdx === -1) continue;
        const k = clean.slice(0, eqIdx).trim();
        obj[k] = parseSimpleTomlValue(clean.slice(eqIdx + 1));
      }
      if (isPresetKind && !obj.name) obj.name = id;
      out.push(obj);
    } catch {
      // Ignore malformed custom toml file
    }
  }
  return out;
}

export function readCatalogFallback() {
  const spaceportsPath = path.join(LWP_DIR, 'data', 'spaceports.toml');
  const rocketsPath = path.join(LWP_DIR, 'data', 'launch_vehicles', 'presets.toml');
  const spacecraftPath = path.join(LWP_DIR, 'data', 'spacecraft', 'presets.toml');

  const spaceports = fs.existsSync(spaceportsPath)
    ? parseTomlArrayTables(fs.readFileSync(spaceportsPath, 'utf8'), 'spaceport')
    : [];

  const presetRockets = fs.existsSync(rocketsPath)
    ? parseTomlArrayTables(fs.readFileSync(rocketsPath, 'utf8'), 'preset').map((r) => ({
        id: r.id,
        is_preset: true,
        based_on: null,
        resolved: {
          config: {
            id: r.id,
            name: r.name || r.id,
            spaceports: Array.isArray(r.spaceports) ? r.spaceports : [],
            any_spaceport: false,
            params: {
              payload_tli_kg: r.payload_tli_kg ?? null,
              upper_stage_name: r.upper_stage_name ?? null,
            },
          },
        },
      }))
    : [];

  const customRockets = loadCustomTomlEntries(
    path.join(LWP_DIR, 'data', 'launch_vehicles', 'custom'),
    true
  ).map((r) => ({
    id: r.id,
    is_preset: false,
    based_on: r.preset || null,
    resolved: {
      config: {
        id: r.id,
        name: r.name || r.id,
        spaceports: Array.isArray(r.spaceports) ? r.spaceports : [],
        any_spaceport: true,
        params: {
          payload_tli_kg: r.payload_tli_kg ?? null,
        },
      },
    },
  }));

  const presetSpacecraft = fs.existsSync(spacecraftPath)
    ? parseTomlArrayTables(fs.readFileSync(spacecraftPath, 'utf8'), 'preset').map((s) => ({
        id: s.id,
        entry: { id: s.id, is_preset: true, based_on: null },
        resolved: {
          config: {
            id: s.id,
            name: s.name || s.id,
            params: {
              dry_mass_kg: s.dry_mass_kg ?? null,
              propellant_mass_kg: s.propellant_mass_kg ?? null,
              payload_mass_kg: s.payload_mass_kg ?? null,
              max_thrust_n: s.max_thrust_n ?? null,
              isp_s: s.isp_s ?? null,
            },
          },
        },
      }))
    : [];

  const customSpacecraft = loadCustomTomlEntries(
    path.join(LWP_DIR, 'data', 'spacecraft', 'custom'),
    true
  ).map((s) => ({
    id: s.id,
    entry: { id: s.id, is_preset: false, based_on: s.preset || null },
    resolved: {
      config: {
        id: s.id,
        name: s.name || s.id,
        params: {
          dry_mass_kg: s.dry_mass_kg ?? null,
          propellant_mass_kg: s.propellant_mass_kg ?? null,
          payload_mass_kg: s.payload_mass_kg ?? null,
          max_thrust_n: s.max_thrust_n ?? null,
          isp_s: s.isp_s ?? null,
        },
      },
    },
  }));

  return {
    spaceports,
    rockets: [...presetRockets, ...customRockets],
    spacecraft: [...presetSpacecraft, ...customSpacecraft],
  };
}

function extractUtcYyyyMmDd(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const directMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (directMatch) {
    return directMatch[1];
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new TrajectoryServiceError(`Invalid UTC date value: "${value}"`, {
      statusCode: 400,
      code: 'bad_request',
    });
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function sanitizeOverrides(raw, fieldName) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new TrajectoryServiceError(`Invalid JSON in ${fieldName}: ${err.message}`, {
        statusCode: 400,
        code: 'bad_request',
      });
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TrajectoryServiceError(`${fieldName} must be an object`, {
      statusCode: 400,
      code: 'bad_request',
    });
  }
  const entries = Object.entries(obj).filter(([k, v]) => k && v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

export function extractLandingWindowConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const adv = input.advanced && typeof input.advanced === 'object' ? input.advanced : {};

  const rawLw =
    input.landing_window ??
    input.landingWindow ??
    adv.landing_window ??
    adv.landingWindow ??
    null;

  const rawMode =
    rawLw?.mode ??
    input.landing_window_mode ??
    input.landingWindowMode ??
    adv.landing_window_mode ??
    adv.landingWindowMode ??
    null;

  const hasExplicitFields = Boolean(rawLw && typeof rawLw === 'object' && !Array.isArray(rawLw));
  if (!rawMode && !hasExplicitFields) {
    return null;
  }

  let base = LANDING_WINDOW_PRESETS.artemis;
  if (typeof rawMode === 'string' && rawMode.trim()) {
    const modeKey = rawMode.trim().toLowerCase();
    if (modeKey === 'strict') {
      base = LANDING_WINDOW_PRESETS.artemis;
    } else if (modeKey === 'any' || modeKey === 'relaxed') {
      base = LANDING_WINDOW_PRESETS.flexible;
    } else if (LANDING_WINDOW_PRESETS[modeKey]) {
      base = LANDING_WINDOW_PRESETS[modeKey];
    } else if (modeKey !== 'custom') {
      throw new TrajectoryServiceError(
        `Invalid landing window mode "${rawMode}" (expected flexible, daylight, daylight_earth, artemis, or custom)`,
        { statusCode: 400, code: 'bad_request' }
      );
    }
  }

  const lwObj = hasExplicitFields ? rawLw : {};
  const merged = {
    require_sun_visible:
      lwObj.require_sun_visible ?? lwObj.requireSunVisible ?? base.require_sun_visible,
    sun_elevation_min_deg:
      lwObj.sun_elevation_min_deg ?? lwObj.sunElevationMinDeg ?? base.sun_elevation_min_deg,
    sun_elevation_max_deg:
      lwObj.sun_elevation_max_deg ?? lwObj.sunElevationMaxDeg ?? base.sun_elevation_max_deg,
    require_earth_visible:
      lwObj.require_earth_visible ?? lwObj.requireEarthVisible ?? base.require_earth_visible,
    max_wait_in_orbit_h:
      lwObj.max_wait_in_orbit_h ?? lwObj.maxWaitInOrbitH ?? base.max_wait_in_orbit_h,
  };

  const requireSun = Boolean(merged.require_sun_visible);
  const requireEarth = Boolean(merged.require_earth_visible);
  const sunMin = Number(merged.sun_elevation_min_deg);
  const sunMax = Number(merged.sun_elevation_max_deg);
  const maxWait = Number(merged.max_wait_in_orbit_h);

  if (
    !Number.isFinite(sunMin) ||
    !Number.isFinite(sunMax) ||
    sunMin < -10.0 ||
    sunMax > 90.0 ||
    sunMin >= sunMax
  ) {
    throw new TrajectoryServiceError(
      'landing_window: require -10 <= sun_elevation_min_deg < sun_elevation_max_deg <= 90',
      { statusCode: 400, code: 'bad_request' }
    );
  }
  if (!Number.isFinite(maxWait) || maxWait < 0.0 || maxWait > 720.0) {
    throw new TrajectoryServiceError(
      'landing_window: max_wait_in_orbit_h must be in [0, 720]',
      { statusCode: 400, code: 'bad_request' }
    );
  }

  return {
    require_sun_visible: requireSun,
    sun_elevation_min_deg: sunMin,
    sun_elevation_max_deg: sunMax,
    require_earth_visible: requireEarth,
    max_wait_in_orbit_h: maxWait,
  };
}

function isArtemisDefaultLandingWindow(lw) {
  if (!lw) return true;
  const d = LANDING_WINDOW_PRESETS.artemis;
  return (
    lw.require_sun_visible === d.require_sun_visible &&
    lw.sun_elevation_min_deg === d.sun_elevation_min_deg &&
    lw.sun_elevation_max_deg === d.sun_elevation_max_deg &&
    lw.require_earth_visible === d.require_earth_visible &&
    lw.max_wait_in_orbit_h === d.max_wait_in_orbit_h
  );
}

function formatTomlFloat(num) {
  const n = Number(num);
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

export function buildTransferTomlWithLandingWindow(baseTomlText, landingWindow) {
  const sectionLines = [
    '[landing_window]',
    `require_sun_visible = ${landingWindow.require_sun_visible ? 'true' : 'false'}`,
    `sun_elevation_min_deg = ${formatTomlFloat(landingWindow.sun_elevation_min_deg)}`,
    `sun_elevation_max_deg = ${formatTomlFloat(landingWindow.sun_elevation_max_deg)}`,
    `require_earth_visible = ${landingWindow.require_earth_visible ? 'true' : 'false'}`,
    `max_wait_in_orbit_h = ${formatTomlFloat(landingWindow.max_wait_in_orbit_h)}`,
  ];

  const source = typeof baseTomlText === 'string' ? baseTomlText.replace(/^\uFEFF/, '') : '';
  if (!source.trim()) {
    return `${sectionLines.join('\n')}\n`;
  }

  const lines = source.split(/\r?\n/);
  const out = [];
  let inLandingWindow = false;
  let replaced = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (trimmed === '[landing_window]') {
      inLandingWindow = true;
      if (!replaced) {
        out.push(...sectionLines);
        replaced = true;
      }
      continue;
    }
    if (inLandingWindow && trimmed.startsWith('[')) {
      inLandingWindow = false;
    }
    if (!inLandingWindow) {
      out.push(line);
    }
  }

  if (!replaced) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') {
      out.push('');
    }
    out.push(...sectionLines);
  }

  return `${out.join('\n').replace(/\n*$/, '\n')}`;
}

export function materializeTransferConfigFile(landingWindow, configDir = GENERATED_TRANSFER_CONFIG_DIR) {
  const baseTransferPath = path.join(LWP_DIR, 'data', 'transfer.toml');
  const baseToml = fs.existsSync(baseTransferPath) ? fs.readFileSync(baseTransferPath, 'utf8') : '';
  const tomlText = buildTransferTomlWithLandingWindow(baseToml, landingWindow);
  const hash = crypto.createHash('sha256').update(tomlText, 'utf8').digest('hex').slice(0, 12);

  fs.mkdirSync(configDir, { recursive: true });
  const targetPath = path.join(configDir, `transfer-${hash}.toml`);
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, tomlText, 'utf8');
  }
  return targetPath;
}

/**
 * Normalizes a frontend / REST payload into an exact `api.rs` `Request` object
 * (which uses `#[serde(deny_unknown_fields)]`).
 */
export function normalizeGenerationInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TrajectoryServiceError('Request body must be a JSON object', {
      statusCode: 400,
      code: 'bad_request',
    });
  }

  const adv = input.advanced && typeof input.advanced === 'object' ? input.advanced : {};
  const request = {};

  const rawLaunch =
    input.launch_date ?? input.launchDate ?? input.launchDateIso ?? adv.launch_date ?? adv.launchDate ?? adv.launchDateIso ?? null;
  const rawArrival =
    input.arrival_date ??
    input.arrivalDate ??
    input.landingDateIso ??
    input.landing_date ??
    adv.arrival_date ??
    adv.arrivalDate ??
    null;

  const dateMode = String(input.dateMode || adv.dateMode || '').trim().toLowerCase();

  if (rawLaunch && rawArrival && !dateMode) {
    throw new TrajectoryServiceError(
      'Specify either launch_date or arrival_date (not both)',
      { statusCode: 400, code: 'bad_request' }
    );
  }

  if (dateMode === 'launch') {
    const d = extractUtcYyyyMmDd(rawLaunch || rawArrival);
    if (d) request.launch_date = d;
  } else if (dateMode === 'arrival') {
    const d = extractUtcYyyyMmDd(rawArrival || rawLaunch);
    if (d) request.arrival_date = d;
  } else if (rawLaunch) {
    const d = extractUtcYyyyMmDd(rawLaunch);
    if (d) request.launch_date = d;
  } else if (rawArrival) {
    const d = extractUtcYyyyMmDd(rawArrival);
    if (d) request.arrival_date = d;
  }

  const rawTraj = input.trajectory ?? adv.trajectory ?? null;
  if (typeof rawTraj === 'string' && rawTraj.trim()) {
    const normTraj = rawTraj.trim().toLowerCase();
    if (normTraj !== 'direct' && normTraj !== 'hohmann') {
      throw new TrajectoryServiceError(
        `Invalid trajectory type "${rawTraj}" (expected "direct" or "hohmann")`,
        { statusCode: 400, code: 'bad_request' }
      );
    }
    request.trajectory = normTraj;
  }

  const rawSpaceport = input.spaceport ?? adv.spaceport ?? null;
  if (typeof rawSpaceport === 'string' && rawSpaceport.trim()) {
    request.spaceport = rawSpaceport.trim();
  }

  const rawRocket = input.rocket ?? adv.rocket ?? null;
  if (typeof rawRocket === 'string' && rawRocket.trim()) {
    request.rocket = rawRocket.trim();
  }

  const rocketOverrides = sanitizeOverrides(
    input.rocket_overrides ?? input.rocketOverrides ?? adv.rocket_overrides ?? adv.rocketOverrides,
    'rocket_overrides'
  );
  if (rocketOverrides) {
    request.rocket_overrides = rocketOverrides;
  }

  const rawSpacecraft = input.spacecraft ?? adv.spacecraft ?? null;
  if (typeof rawSpacecraft === 'string' && rawSpacecraft.trim()) {
    request.spacecraft = rawSpacecraft.trim();
  }

  const spacecraftOverrides = sanitizeOverrides(
    input.spacecraft_overrides ??
      input.spacecraftOverrides ??
      adv.spacecraft_overrides ??
      adv.spacecraftOverrides,
    'spacecraft_overrides'
  );
  if (spacecraftOverrides) {
    request.spacecraft_overrides = spacecraftOverrides;
  }

  const site = input.landing_site ?? input.landingSite ?? null;
  if (site && typeof site === 'object') {
    const lat = Number(site.lat_deg ?? site.lat);
    const lon = Number(site.lon_deg ?? site.lon);
    if (Number.isFinite(lat) || Number.isFinite(lon)) {
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new TrajectoryServiceError('landing_site.lat_deg must be in [-90, 90]', {
          statusCode: 400,
          code: 'bad_request',
        });
      }
      if (!Number.isFinite(lon) || lon < -180 || lon > 360) {
        throw new TrajectoryServiceError('landing_site.lon_deg must be in [-180, 360]', {
          statusCode: 400,
          code: 'bad_request',
        });
      }
      request.landing_site = { lat_deg: lat, lon_deg: lon };
    }
  }

  const rawHeightM = input.height_m ?? input.heightM ?? adv.height_m ?? adv.heightM ?? null;
  if (rawHeightM !== null && rawHeightM !== undefined && rawHeightM !== '') {
    const h = Number(rawHeightM);
    if (!Number.isFinite(h)) {
      throw new TrajectoryServiceError('height_m must be a finite number', {
        statusCode: 400,
        code: 'bad_request',
      });
    }
    request.height_m = h;
  }

  const rawVis = input.visibility ?? adv.visibility ?? null;
  if (rawVis && typeof rawVis === 'object' && !Array.isArray(rawVis)) {
    const vis = {};
    if (typeof rawVis.start === 'string' && rawVis.start.trim()) {
      vis.start = rawVis.start.trim();
    }
    if (rawVis.hours !== null && rawVis.hours !== undefined && rawVis.hours !== '') {
      const hours = Number(rawVis.hours);
      if (!Number.isFinite(hours) || hours < 0) {
        throw new TrajectoryServiceError('visibility.hours must be a non-negative number', {
          statusCode: 400,
          code: 'bad_request',
        });
      }
      vis.hours = hours;
    }
    const stepRaw = rawVis.step_min ?? rawVis.stepMin;
    if (stepRaw !== null && stepRaw !== undefined && stepRaw !== '') {
      const stepMin = Number(stepRaw);
      if (!Number.isFinite(stepMin) || stepMin <= 0) {
        throw new TrajectoryServiceError('visibility.step_min must be a positive number', {
          statusCode: 400,
          code: 'bad_request',
        });
      }
      vis.step_min = stepMin;
    }
    if (Object.keys(vis).length > 0) {
      request.visibility = vis;
    }
  }

  const noTerrain = Boolean(input.noTerrain ?? adv.noTerrain);
  const rawTerrainDir = input.terrain_dir ?? input.terrainDir ?? adv.terrain_dir ?? adv.terrainDir;
  if (noTerrain) {
    request.terrain_dir = '';
  } else if (typeof rawTerrainDir === 'string') {
    request.terrain_dir = rawTerrainDir;
  }

  const rawKernelsDir = input.kernels_dir ?? input.kernelsDir ?? adv.kernels_dir ?? adv.kernelsDir;
  if (typeof rawKernelsDir === 'string' && rawKernelsDir.trim()) {
    request.kernels_dir = rawKernelsDir.trim();
  }

  if (Boolean(input.download_kernels ?? input.downloadKernels ?? adv.download_kernels)) {
    request.download_kernels = true;
  }

  for (const [kSrc, kAlt, kDest] of [
    ['transfer_config', 'transferConfig', 'transfer_config'],
    ['landing_config', 'landingConfig', 'landing_config'],
    ['visibility_config', 'visibilityConfig', 'visibility_config'],
  ]) {
    const v = input[kSrc] ?? input[kAlt] ?? adv[kSrc] ?? adv[kAlt];
    if (typeof v === 'string' && v.trim()) {
      request[kDest] = v.trim();
    }
  }

  if (Boolean(input.no_cache ?? input.noCache ?? adv.no_cache ?? adv.noCache)) {
    request.no_cache = true;
  }

  if (!request.launch_date && !request.arrival_date && !request.landing_site) {
    throw new TrajectoryServiceError(
      'Specify a landing/launch date or landing site coordinates to calculate a trajectory.',
      { statusCode: 400, code: 'bad_request' }
    );
  }

  return request;
}

function exitCodeToStatus(exitCode, errCode) {
  if (errCode === 'bad_request' || exitCode === 2) return 400;
  if (errCode === 'not_found' || exitCode === 3) return 404;
  if (errCode === 'not_ready' || exitCode === 4) return 409;
  return 500;
}

export async function runLwpApi(
  apiArgs,
  { requestPayload = null, jobsDir = DEFAULT_JOBS_DIR, runnerOverride = null } = {}
) {
  if (typeof runnerOverride === 'function') {
    return runnerOverride({ apiArgs, requestPayload, jobsDir });
  }

  const runner = resolveLwpRunner();
  if (!runner) {
    throw new TrajectoryServiceError(
      'Trajectory solver binary is not built yet. Build launch-window-prediction (`cargo build --release` in trajectory/Lunar-Window-Navigator/launch-window-prediction) or set LWP_BIN.',
      {
        statusCode: 503,
        code: 'binary_not_built',
        details: { lwpDir: LWP_DIR },
      }
    );
  }

  const fullArgs = [...runner.baseArgs, 'api', '--jobs-dir', jobsDir, ...apiArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(runner.cmd, fullArgs, {
      cwd: runner.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(
        new TrajectoryServiceError(`Failed to spawn trajectory solver: ${err.message}`, {
          statusCode: 500,
          code: 'internal',
        })
      );
    });

    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();

      let parsed = null;
      if (stdoutText) {
        try {
          parsed = JSON.parse(stdoutText);
        } catch {
          parsed = null;
        }
      }

      if (!parsed || typeof parsed !== 'object') {
        reject(
          new TrajectoryServiceError(
            stderrText || stdoutText || `Trajectory solver exited with code ${code ?? 'unknown'}`,
            {
              statusCode: 500,
              code: 'internal',
            }
          )
        );
        return;
      }

      if (!parsed.ok) {
        const errCode = parsed.error?.code || 'internal';
        const errMsg = parsed.error?.message || 'Trajectory solver error';
        reject(
          new TrajectoryServiceError(errMsg, {
            statusCode: exitCodeToStatus(code, errCode),
            code: errCode,
            details: parsed,
          })
        );
        return;
      }

      resolve(parsed);
    });

    if (requestPayload !== null && requestPayload !== undefined) {
      child.stdin.write(JSON.stringify(requestPayload));
    }
    child.stdin.end();
  });
}

export async function getTrajectoryCatalog({ runnerOverride = null } = {}) {
  try {
    const reply = await runLwpApi(['catalog'], { runnerOverride });
    return {
      ok: true,
      available: true,
      source: 'lwp-api/1',
      api: reply.api || 'lwp-api/1',
      spaceports: reply.spaceports || [],
      rockets: reply.rockets || [],
      spacecraft: reply.spacecraft || [],
    };
  } catch (err) {
    if (err instanceof TrajectoryServiceError && err.code === 'binary_not_built') {
      const fallback = readCatalogFallback();
      return {
        ok: true,
        available: false,
        source: 'toml-fallback',
        api: 'lwp-api/1',
        message: err.message,
        ...fallback,
      };
    }
    throw err;
  }
}

export async function submitTrajectoryJob(
  input,
  { wait = false, jobsDir = DEFAULT_JOBS_DIR, runnerOverride = null, transferConfigDir = GENERATED_TRANSFER_CONFIG_DIR } = {}
) {
  const request = normalizeGenerationInput(input);
  const landingWindow = extractLandingWindowConfig(input);
  if (!request.transfer_config && landingWindow && !isArtemisDefaultLandingWindow(landingWindow)) {
    request.transfer_config = materializeTransferConfigFile(landingWindow, transferConfigDir);
  }

  const args = wait ? ['submit', '--wait'] : ['submit'];
  const reply = await runLwpApi(args, {
    requestPayload: request,
    jobsDir,
    runnerOverride,
  });
  return {
    ok: true,
    api: reply.api || 'lwp-api/1',
    request,
    job: reply.job,
    ...(reply.summary !== undefined ? { summary: reply.summary } : {}),
  };
}

export async function getTrajectoryJobStatus(
  jobId,
  { jobsDir = DEFAULT_JOBS_DIR, runnerOverride = null } = {}
) {
  const cleanId = String(jobId || '').trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    throw new TrajectoryServiceError(`Invalid job id '${cleanId}'`, {
      statusCode: 400,
      code: 'bad_request',
    });
  }
  const reply = await runLwpApi(['status', cleanId], { jobsDir, runnerOverride });
  return {
    ok: true,
    api: reply.api || 'lwp-api/1',
    job: reply.job,
  };
}

export async function getTrajectoryJobResult(
  jobId,
  { part = 'all', jobsDir = DEFAULT_JOBS_DIR, runnerOverride = null } = {}
) {
  const cleanId = String(jobId || '').trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    throw new TrajectoryServiceError(`Invalid job id '${cleanId}'`, {
      statusCode: 400,
      code: 'bad_request',
    });
  }
  const validParts = ['summary', 'trajectory', 'log', 'output', 'all'];
  const cleanPart = validParts.includes(part) ? part : null;
  if (!cleanPart) {
    throw new TrajectoryServiceError(
      `Invalid result part '${part}' (expected summary, trajectory, log, output, all)`,
      { statusCode: 400, code: 'bad_request' }
    );
  }
  const reply = await runLwpApi(['result', cleanId, '--part', cleanPart], {
    jobsDir,
    runnerOverride,
  });
  return {
    ok: true,
    api: reply.api || 'lwp-api/1',
    job: reply.job,
    part: reply.part || cleanPart,
    data: reply.data,
  };
}
