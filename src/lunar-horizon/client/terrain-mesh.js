// Concentric square grids keep triangles approximately square at every distance.
// Fine outer edges meet the next level exactly, including intermediate vertices.
export function buildTerrainMesh(local, resolution, segments = 256, levels = 8, spacing = 30) {
  const stride = segments + 1;
  const verticesPerLevel = stride * stride;
  const totalVertices = levels * verticesPerLevel;
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const innerHole = (segments / 2) * (segments / 2);
  const totalQuads = segments * segments + (levels - 1) * (segments * segments - innerHole);
  const indices = new Uint32Array(totalQuads * 6);

  const normalAt = (east, north, outX, outArr, outIdx) => {
    const h = Math.max(resolution, Math.hypot(east, north) * 0.004);
    const w = local(east - h, north);
    const e = local(east + h, north);
    const s = local(east, north - h);
    const n = local(east, north + h);
    const ux = e[0] - w[0], uy = e[1] - w[1], uz = e[2] - w[2];
    const vx = n[0] - s[0], vy = n[1] - s[1], vz = n[2] - s[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const invLen = 1 / Math.hypot(cx, cy, cz);
    if (outArr) {
      outArr[outIdx] = cx * invLen;
      outArr[outIdx + 1] = cy * invLen;
      outArr[outIdx + 2] = cz * invLen;
      return null;
    }
    return [cx * invLen, cy * invLen, cz * invLen];
  };

  let vWrite = 0;
  let iWrite = 0;
  for (let level = 0; level < levels; level++) {
    const step = spacing * (2 ** level);
    const offset = level * verticesPerLevel;
    for (let row = 0; row <= segments; row++) {
      for (let col = 0; col <= segments; col++) {
        const east = (col - segments / 2) * step;
        const north = (segments / 2 - row) * step;
        const vertical = (col === 0 || col === segments) && row % 2 === 1;
        const horizontal = (row === 0 || row === segments) && col % 2 === 1;
        if (level < levels - 1 && (vertical || horizontal)) {
          const de = horizontal ? step : 0;
          const dn = vertical ? step : 0;
          const a = local(east - de, north - dn);
          const b = local(east + de, north + dn);
          positions[vWrite] = (a[0] + b[0]) * 0.5;
          positions[vWrite + 1] = (a[1] + b[1]) * 0.5;
          positions[vWrite + 2] = (a[2] + b[2]) * 0.5;
          const an = normalAt(east - de, north - dn);
          const bn = normalAt(east + de, north + dn);
          normals[vWrite] = (an[0] + bn[0]) * 0.5;
          normals[vWrite + 1] = (an[1] + bn[1]) * 0.5;
          normals[vWrite + 2] = (an[2] + bn[2]) * 0.5;
        } else {
          const p = local(east, north);
          positions[vWrite] = p[0];
          positions[vWrite + 1] = p[1];
          positions[vWrite + 2] = p[2];
          normalAt(east, north, 0, normals, vWrite);
        }
        vWrite += 3;
      }
    }
    for (let row = 0; row < segments; row++) {
      for (let col = 0; col < segments; col++) {
        if (level > 0 && row >= segments / 4 && row < segments * 3 / 4 && col >= segments / 4 && col < segments * 3 / 4) continue;
        const a = offset + row * stride + col;
        indices[iWrite++] = a;
        indices[iWrite++] = a + stride;
        indices[iWrite++] = a + 1;
        indices[iWrite++] = a + 1;
        indices[iWrite++] = a + stride;
        indices[iWrite++] = a + stride + 1;
      }
    }
  }
  const landingFaces = [];
  for (const row of [segments / 2 - 1, segments / 2]) {
    for (const col of [segments / 2 - 1, segments / 2]) {
      const offset = (row * segments + col) * 6;
      for (let k = 0; k < 6; k++) landingFaces.push(indices[offset + k]);
    }
  }
  return {
    positions,
    normals,
    indices,
    landingFaces,
    centerIndex: (stride * stride - 1) / 2,
    extent: segments * spacing * (2 ** (levels - 1)) / 2,
  };
}

// Terrain is piecewise planar. Clip to the actual face footprint before
// comparing heights so that ridges and valleys both get the correct support.
export function landingSurface({positions, landingFaces}) {
  const faces = [];
  for (let i = 0; i < landingFaces.length; i += 3) {
    const vertices = landingFaces.slice(i, i + 3).map(index => Array.from(positions.subarray(index * 3, index * 3 + 3)));
    const [a, b, c] = vertices;
    const bx = b[0] - a[0], bz = b[2] - a[2];
    const cx = c[0] - a[0], cz = c[2] - a[2];
    const area = bx * cz - bz * cx;
    const height = (x, z) => {
      const u = ((x - a[0]) * cz - (z - a[2]) * cx) / area;
      const v = (bx * (z - a[2]) - bz * (x - a[0])) / area;
      return a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
    };
    const edges = vertices.map((p, j) => {
      const q = vertices[(j + 1) % 3];
      return ([x, , z]) => Math.sign(area) * ((q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]));
    });
    faces.push({height, edges});
  }
  return {
    heightAt(x, z) {
      const point = [x, 0, z];
      return faces.find(face => face.edges.every(side => side(point) >= -1e-8))?.height(x, z);
    },
    penetration(triangle) {
      let depth = -Infinity;
      for (const {edges, height} of faces) {
        let polygon = triangle;
        for (const side of edges) {
          const clipped = [];
          for (let j = 0; j < polygon.length; j++) {
            const a = polygon[j], b = polygon[(j + 1) % polygon.length];
            const da = side(a), db = side(b);
            if (da >= 0) clipped.push(a);
            if ((da >= 0) !== (db >= 0)) {
              const t = da / (da - db);
              clipped.push(a.map((value, axis) => value + t * (b[axis] - value)));
            }
          }
          polygon = clipped;
        }
        for (const [x, y, z] of polygon) depth = Math.max(depth, height(x, z) - y);
      }
      return depth;
    },
  };
}
