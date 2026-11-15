import {imageryProjection, imageryCoordinates} from './imagery.js?v=terrain-v3';
import {R, D, project, frame, dot, sample} from './math.js?v=terrain-v3';
import {buildTerrainMesh} from './terrain-mesh.js?v=overview-v1';
import {sampleGlobal, sampleDetail} from './dem.js?v=terrain-v3';

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
    const {lat, lon, height, near, far, nm, fm, global, detailTile, fineTile, landingTile} = data;
    const basis = frame(lat, lon);
    const polarHeight = (grid, meta, latitude, longitude) =>
      grid ? sample(grid, meta, ...project(latitude, longitude)) : NaN;
    function blendPolar(grid, meta, latitude, longitude, fallback) {
      const [x, y] = project(latitude, longitude);
      const value = grid ? sample(grid, meta, x, y) : NaN;
      if (!Number.isFinite(value)) return fallback;
      if (!Number.isFinite(fallback)) return value;
      const col = (x - meta.x0) / meta.dx - 0.5;
      const row = (y - meta.y0) / meta.dy - 0.5;
      const u = Math.max(0, Math.min(1, Math.min(col, row, meta.width-1-col, meta.height-1-row) / 8));
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
    if (data.reportGround) postMessage({phase: 'ground', ground});
    const detailed = Number.isFinite(polarHeight(near, nm, lat, lon));
    const regional = Number.isFinite(polarHeight(far, fm, lat, lon));
    const resolution = detailed && nm.resolution < 30 ? nm.resolution : landingTile ? (landingTile.source === 'SLDEM2015' ? 60 : 30) : detailed ? nm.resolution : fineTile ? 118 : detailTile ? 474 : regional ? 640 : 3790;
    const origin = basis.up.map(value => value * (R + ground));
    const sampleUnit = unit => elevation(Math.asin(Math.max(-1, Math.min(1, unit[2]))) / D, Math.atan2(unit[1], unit[0]) / D);
    function local(east, north) {
      const distance = Math.hypot(east, north);
      if (distance === 0) return [0, 0, 0];
      const angle = distance / R;
      const unit = basis.up.map((value, i) => value * Math.cos(angle)
        + (basis.east[i] * east + basis.north[i] * north) * Math.sin(angle) / distance);
      const radius = R + sampleUnit(unit);
      const delta = unit.map((value, i) => value * radius - origin[i]);
      return [dot(delta, basis.east), dot(delta, basis.up), -dot(delta, basis.north)];
    }

    if (data.preview) {
      const {positions, normals, indices} = buildTerrainMesh(local, resolution, 32, 8, 240);
      const drawRanges = sortOverviewByDistance(positions, indices);
      postMessage({positions, normals, indices, drawRanges}, [positions.buffer, normals.buffer, indices.buffer]);
      return;
    }
    const mesh = buildTerrainMesh(local, resolution);

    // Geographic UVs stay correct across the date line and on a curved surface.
    const uvs = new Float32Array(mesh.positions.length / 3 * 2);
    for(let i=0;i<mesh.positions.length;i+=3) {
      const point=basis.up.map((v,k)=>origin[k]+basis.east[k]*mesh.positions[i]+v*mesh.positions[i+1]-basis.north[k]*mesh.positions[i+2]);
      const latitude=Math.asin(point[2]/Math.hypot(...point))/D;
      const longitude=Math.atan2(point[1],point[0])/D;
      const uv=imageryCoordinates(latitude,longitude,imageryProjection(lat),lon);
      uvs[i/3*2]=uv[0];
      uvs[i/3*2+1]=uv[1];
    }
    const horizon = new Float32Array(720);
    if (data.reportProgress) postMessage({phase: 'horizon', complete: 0, total: horizon.length});
    for (let index = 0; index < horizon.length; index++) {
      const azimuth = index / 2 * D;
      const tangent = basis.north.map((value, i) => value * Math.cos(azimuth) + basis.east[i] * Math.sin(azimuth));
      let peak = -90;
      for (let distance = landingTile || detailed || fineTile ? 20 : detailTile ? 100 : regional ? 160 : 250; distance <= 250000;
        distance += landingTile && distance < 2400 ? 15 : detailed && distance < 24000 ? Math.max(10, nm.resolution / 2) : fineTile && distance < 9000 ? 55 : detailTile && distance < 65000 ? 230 : regional ? 320 : 950) {
        const angle = distance / R;
        const unit = basis.up.map((value, i) => value * Math.cos(angle) + tangent[i] * Math.sin(angle));
        const radius = R + sampleUnit(unit);
        if (!Number.isFinite(radius)) throw new Error('Insufficient elevation coverage for the horizon.');
        const angleToTerrain = Math.atan2(radius * Math.cos(angle) - (R + ground + height), radius * Math.sin(angle)) / D;
        peak = Math.max(peak, angleToTerrain);
      }
      horizon[index] = peak;
      if (data.reportProgress && (index + 1) % 60 === 0) {
        postMessage({phase: 'horizon', complete: index + 1, total: horizon.length});
      }
    }

    const west = local(-resolution, 0), east = local(resolution, 0);
    const south = local(0, -resolution), north = local(0, resolution);
    const u = east.map((value, i) => value - west[i]);
    const v = north.map((value, i) => value - south[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    postMessage({...mesh, uvs, lat, lon, horizon, ground, normal: normal.map(value => value / length), resolution}, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, uvs.buffer, horizon.buffer]);
  } catch (error) {
    postMessage({error: error.message});
  }
};
