export const GLOBAL_WIDTH = 2880;
export const GLOBAL_HEIGHT = 1440;

export function sampleGlobal(grid, lat, lon) {
  const x = ((lon % 360 + 360) % 360) * 8 - 0.5;
  const y = Math.max(0, Math.min(GLOBAL_HEIGHT - 1, (90 - lat) * 8 - 0.5));
  const column = Math.floor(x);
  const row = Math.floor(y);
  const left = (column + GLOBAL_WIDTH) % GLOBAL_WIDTH;
  const right = (left + 1) % GLOBAL_WIDTH;
  const next = Math.min(row + 1, GLOBAL_HEIGHT - 1);
  const u = x - column;
  const v = y - row;
  return (grid[row * GLOBAL_WIDTH + left] * (1 - u) + grid[row * GLOBAL_WIDTH + right] * u) * (1 - v)
    + (grid[next * GLOBAL_WIDTH + left] * (1 - u) + grid[next * GLOBAL_WIDTH + right] * u) * v;
}

export async function loadPackedDem(url, width, height, scale = 1) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load elevation data.');
  const unpacked = new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
  const bytes = new DataView(await unpacked.arrayBuffer());
  if (bytes.byteLength !== width * height * 2) throw new Error('Incomplete elevation data.');
  const values = new Int16Array(width * height);
  for (let row = 0; row < height; row++) {
    let previous = 0;
    for (let i = row * width; i < (row + 1) * width; i++) {
      previous = (previous + bytes.getInt16(i * 2, true)) << 16 >> 16;
      values[i] = previous;
    }
  }
  return scale === 1 ? values : Float32Array.from(values, value => value === -32768 ? NaN : value * scale);
}

// Distance from the tile edge controls the transition to the global overview.
export function sampleDetail(tile, latitude, longitude, baseHeight) {
  const density = tile.density ?? 64;
  const width = density * 360, height = density * 180;
  const longitudeCell = ((longitude % 360 + 360) % 360) * density - 0.5;
  const latitudeCell = Math.max(0, Math.min(height - 1, (90 - latitude) * density - 0.5));
  const x = ((longitudeCell - tile.firstColumn) % width + width) % width;
  const y = latitudeCell - tile.firstRow;
  const fullLongitude = tile.columns === width;
  if ((!fullLongitude && x >= tile.columns - 1) || y < 0 || y > tile.rows - 1) return baseHeight;
  const column = Math.floor(x), row = Math.floor(y);
  const right = (column + 1) % tile.columns;
  const below = Math.min(row + 1, tile.rows - 1);
  const u = x - column, v = y - row;
  const near = tile.values[row * tile.columns + column] * (1 - u) + tile.values[row * tile.columns + right] * u;
  const far = tile.values[below * tile.columns + column] * (1 - u) + tile.values[below * tile.columns + right] * u;
  const edge = Math.min(
    fullLongitude ? Infinity : Math.min(x, tile.columns - 1 - x),
    tile.firstRow === 0 ? Infinity : y,
    tile.firstRow + tile.rows === height ? Infinity : tile.rows - 1 - y,
  );
  const uBlend = Math.max(0, Math.min(1, edge / (tile.blendCells ?? 8)));
  const blend = uBlend * uBlend * (3 - 2 * uBlend);
  return baseHeight + ((tile.scale ?? 0.5) * (near * (1 - v) + far * v) - baseHeight) * blend;
}
