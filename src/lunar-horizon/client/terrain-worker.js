import {imageryProjection, imageryCoordinates} from './imagery.js?v=terrain-v3';
import {R, D, project, frame, sample} from './math.js?v=terrain-v3';
import {buildTerrainMesh} from './terrain-mesh.js?v=overview-v1';
import {sampleGlobal, sampleDetail} from './dem.js?v=terrain-v3';

let cachedGlobal = null;
let cachedNear = null;
let cachedFar = null;
let cachedNm = null;
let cachedFm = null;

function sortOverviewByDistance(positions, indices) {
  const limits = [1000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, Infinity];
  const bands = limits.map(() => []);
  for (let i = 0; i < indices.length; i += 3) {
    let radius = 0;
    for (let j = 0; j < 3; j++) {
      const vertex = indices[i + j] * 3;
      radius = Math.max(radius, Math.hypot(positions[vertex], positions[vertex + 2]));
    }
    bands[limits.findIndex(limit => radius <= limit)].push(indices[i], indices[i + 1], indices[i + 2]);
  }
  const drawRanges = [];
  let offset = 0;
  for (const band of bands) {
    if (!band.length) continue;
    indices.set(band, offset);
    offset += band.length;
    drawRanges.push(offset);
  }
  return drawRanges;
}

onmessage = ({data}) => {
  try {
    if (data.type === 'cache') {
      if (data.global !== undefined) cachedGlobal = data.global;
      if (data.near !== undefined) cachedNear = data.near;
      if (data.far !== undefined) cachedFar = data.far;
      if (data.nm !== undefined) cachedNm = data.nm;
      if (data.fm !== undefined) cachedFm = data.fm;
      return;
    }

    const {jobId, lat, lon, height, detailTile, fineTile, landingTile} = data;
    const near = data.near !== undefined ? data.near : cachedNear;
    const far = data.far !== undefined ? data.far : cachedFar;
    const nm = data.nm !== undefined ? data.nm : cachedNm;
    const fm = data.fm !== undefined ? data.fm : cachedFm;
    const global = data.global !== undefined ? data.global : cachedGlobal;

    const basis = frame(lat, lon);
    const up0 = basis.up[0], up1 = basis.up[1], up2 = basis.up[2];
    const east0 = basis.east[0], east1 = basis.east[1], east2 = basis.east[2];
    const north0 = basis.north[0], north1 = basis.north[1], north2 = basis.north[2];

    const polarHeight = (grid, meta, latitude, longitude) =>
      grid ? sample(grid, meta, ...project(latitude, longitude)) : NaN;
    function blendPolar(grid, meta, latitude, longitude, fallback) {
      const [x, y] = project(latitude, longitude);
      const value = grid ? sample(grid, meta, x, y) : NaN;
      if (!Number.isFinite(value)) return fallback;
      if (!Number.isFinite(fallback)) return value;
      const col = (x - meta.x0) / meta.dx - 0.5;
      const row = (y - meta.y0) / meta.dy - 0.5;
      const u = Math.max(0, Math.min(1, Math.min(col, row, meta.width - 1 - col, meta.height - 1 - row) / 8));
      const weight = u * u * (3 - 2 * u);
      return fallback + (value - fallback) * weight;
    }
    function elevation(latitude, longitude) {
      let value = global ? sampleGlobal(global, latitude, longitude) : NaN;
      if (latitude < -79) value = blendPolar(far, fm, latitude, longitude, value);
      if (detailTile) value = sampleDetail(detailTile, latitude, longitude, value);
      if (fineTile) value = sampleDetail(fineTile, latitude, longitude, value);
      if (latitude < -79 && nm?.resolution >= 30) value = blendPolar(near, nm, latitude, longitude, value);
      if (landingTile) value = sampleDetail(landingTile, latitude, longitude, value);
      // The 20 m polar product has priority over the coarser cylindrical DEM.
      if (latitude < -79 && nm?.resolution < 30) value = blendPolar(near, nm, latitude, longitude, value);
      return value;
    }
    const ground = elevation(lat, lon);
    if (!Number.isFinite(ground)) throw new Error('No elevation coverage at this location.');
    if (data.reportGround) postMessage({jobId, phase: 'ground', ground});
    const detailed = Number.isFinite(polarHeight(near, nm, lat, lon));
    const regional = Number.isFinite(polarHeight(far, fm, lat, lon));
    const resolution = detailed && nm.resolution < 30 ? nm.resolution
      : landingTile ? (landingTile.source === 'SLDEM2015' ? 60 : 30)
      : detailed ? nm.resolution
      : fineTile ? 118
      : detailTile ? 474
      : regional ? 640 : 3790;
    const originRadius = R + ground;
    const ox = up0 * originRadius, oy = up1 * originRadius, oz = up2 * originRadius;

    function sampleUnitScalars(ux, uy, uz) {
      const clampedZ = uz > 1 ? 1 : (uz < -1 ? -1 : uz);
      return elevation(Math.asin(clampedZ) / D, Math.atan2(uy, ux) / D);
    }

    function local(east, north) {
      const distance = Math.hypot(east, north);
      if (distance === 0) return [0, 0, 0];
      const angle = distance / R;
      const cosA = Math.cos(angle);
      const sinOverDist = Math.sin(angle) / distance;
      const ux = up0 * cosA + (east0 * east + north0 * north) * sinOverDist;
      const uy = up1 * cosA + (east1 * east + north1 * north) * sinOverDist;
      const uz = up2 * cosA + (east2 * east + north2 * north) * sinOverDist;
      const radius = R + sampleUnitScalars(ux, uy, uz);
      const dx = ux * radius - ox;
      const dy = uy * radius - oy;
      const dz = uz * radius - oz;
      return [
        dx * east0 + dy * east1 + dz * east2,
        dx * up0 + dy * up1 + dz * up2,
        -(dx * north0 + dy * north1 + dz * north2),
      ];
    }

    if (data.preview) {
      const {positions, normals, indices} = buildTerrainMesh(local, resolution, 32, 8, 240);
      const drawRanges = sortOverviewByDistance(positions, indices);
      postMessage({jobId, positions, normals, indices, drawRanges}, [positions.buffer, normals.buffer, indices.buffer]);
      return;
    }
    const mesh = buildTerrainMesh(local, resolution);

    // Geographic UVs stay correct across the date line and on a curved surface.
    const pos = mesh.positions;
    const uvs = new Float32Array(pos.length / 3 * 2);
    const projection = imageryProjection(lat);
    for (let i = 0, uvIdx = 0; i < pos.length; i += 3, uvIdx += 2) {
      const mx = pos[i], my = pos[i + 1], mz = pos[i + 2];
      const px = ox + east0 * mx + up0 * my - north0 * mz;
      const py = oy + east1 * mx + up1 * my - north1 * mz;
      const pz = oz + east2 * mx + up2 * my - north2 * mz;
      const latitude = Math.asin(pz / Math.hypot(px, py, pz)) / D;
      const longitude = Math.atan2(py, px) / D;
      const uv = imageryCoordinates(latitude, longitude, projection, lon);
      uvs[uvIdx] = uv[0];
      uvs[uvIdx + 1] = uv[1];
    }

    const horizon = new Float32Array(720);
    if (data.reportProgress) postMessage({jobId, phase: 'horizon', complete: 0, total: horizon.length});
    const observerRadius = R + ground + height;
    const startDist = landingTile || detailed || fineTile ? 20 : detailTile ? 100 : regional ? 160 : 250;

    for (let index = 0; index < horizon.length; index++) {
      const azimuth = index / 2 * D;
      const cosAz = Math.cos(azimuth), sinAz = Math.sin(azimuth);
      const tx = north0 * cosAz + east0 * sinAz;
      const ty = north1 * cosAz + east1 * sinAz;
      const tz = north2 * cosAz + east2 * sinAz;
      let peak = -90;
      for (
        let distance = startDist;
        distance <= 250000;
        distance += landingTile && distance < 2400 ? 15
          : detailed && distance < 24000 ? Math.max(10, nm.resolution / 2)
          : fineTile && distance < 9000 ? 55
          : detailTile && distance < 65000 ? 230
          : regional ? 320 : 950
      ) {
        const angle = distance / R;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const ux = up0 * cosA + tx * sinA;
        const uy = up1 * cosA + ty * sinA;
        const uz = up2 * cosA + tz * sinA;
        const radius = R + sampleUnitScalars(ux, uy, uz);
        if (!Number.isFinite(radius)) throw new Error('Insufficient elevation coverage for the horizon.');
        const angleToTerrain = Math.atan2(radius * cosA - observerRadius, radius * sinA) / D;
        if (angleToTerrain > peak) peak = angleToTerrain;
      }
      horizon[index] = peak;
      if (data.reportProgress && (index + 1) % 60 === 0) {
        postMessage({jobId, phase: 'horizon', complete: index + 1, total: horizon.length});
      }
    }

    const west = local(-resolution, 0), east = local(resolution, 0);
    const south = local(0, -resolution), north = local(0, resolution);
    const u = [east[0] - west[0], east[1] - west[1], east[2] - west[2]];
    const v = [north[0] - south[0], north[1] - south[1], north[2] - south[2]];
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    const invNormLen = 1 / Math.hypot(nx, ny, nz);
    postMessage(
      {
        jobId,
        ...mesh,
        uvs,
        lat,
        lon,
        horizon,
        ground,
        normal: [nx * invNormLen, ny * invNormLen, nz * invNormLen],
        resolution,
      },
      [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, uvs.buffer, horizon.buffer]
    );
  } catch (error) {
    postMessage({jobId: data?.jobId, error: error.message});
  }
};
