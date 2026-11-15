import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDriveFile,
  getCachedFilePath,
  getDriveFileEntry,
  preferLocalAssets,
  readDriveRange,
  readLroWacTileFromDrive,
} from '../gdrive/driveClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CACHE_ROOT = path.join(PROJECT_ROOT, 'cache', 'lunar-dem');
const LOCAL_WAC_DIR = path.join(PROJECT_ROOT, 'public', 'tiles', 'lro_wac');
const LOCAL_LDEM64_PATH = path.join(CACHE_ROOT, 'ldem_64.img');
const LWP_LDEM64_LOGICAL_PATH =
  'trajectory/Lunar-Window-Navigator/launch-window-prediction/data/terrain/LDEM_64.IMG';
const LWP_LDEM64_LOCAL_PATH = path.join(
  PROJECT_ROOT,
  'trajectory',
  'Lunar-Window-Navigator',
  'launch-window-prediction',
  'data',
  'terrain',
  'LDEM_64.IMG'
);

const ephemMemCache = new Map();
const ephemInFlight = new Map();
const tileMemCache = new Map();
const tileInFlight = new Map();
const imageryMemCache = new Map();
const imageryInFlight = new Map();

function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const val = map.get(key);
  map.delete(key);
  map.set(key, val);
  return val;
}

function lruSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

async function readFileRange(filePath, start, end) {
  const length = end - start + 1;
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) {
        throw new Error('Unexpected EOF reading local DEM file.');
      }
      offset += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    await handle.close();
  }
}

// Server-side proxy: Horizons does not support browser CORS.
export async function ephemeris(url) {
  const p = url.searchParams;
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  const alt = Number(p.get('alt'));
  const start = Date.parse(p.get('start'));
  const end = Date.parse(p.get('end'));
  const step = Number(p.get('step') || 10);

  if (
    ![lat, lon, alt, start, end, step].every(Number.isFinite) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    alt < -15 ||
    alt > 15 ||
    start >= end ||
    end - start > (p.get('target') === 'sun' ? 730 : 365) * 86400000 ||
    step < 1 ||
    step > 60 ||
    new Date(start).getUTCFullYear() < 2000 ||
    new Date(end).getUTCFullYear() > 2100
  ) {
    throw new Error('Check coordinates, dates (2000–2100), mission duration up to 365 days and time step (1–60 min).');
  }

  const sunOnly = p.get('target') === 'sun';
  const viewMode = p.get('view') === 'sky-v1' ? 'sky-v1' : 'std';
  const cacheKey = `${lat.toFixed(3)}_${lon.toFixed(3)}_${alt.toFixed(2)}_${start}_${end}_${step}_${sunOnly ? 'sun' : 'all'}_${viewMode}`;

  const memHit = lruGet(ephemMemCache, cacheKey);
  if (memHit) return memHit;

  if (ephemInFlight.has(cacheKey)) {
    return ephemInFlight.get(cacheKey);
  }

  const work = (async () => {
    const cachePath = path.join(CACHE_ROOT, 'ephemeris', `${cacheKey}.json`);
    try {
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      lruSet(ephemMemCache, cacheKey, cached, 64);
      return cached;
    } catch {
      // Ігноруємо відсутній/пошкоджений кеш і перезапитуємо
    }

    const count = Math.ceil((end - start) / (step * 60000));
    if (count > 15000) throw new Error('Too many samples. Increase the time step.');

    const getChunk = async (target, from, to) => {
      const globe = target === 399 && viewMode === 'sky-v1';
      const q = {
        format: 'json',
        COMMAND: `'${target}'`,
        OBJ_DATA: "'NO'",
        EPHEM_TYPE: "'OBSERVER'",
        CENTER: "'coord@301'",
        COORD_TYPE: "'GEODETIC'",
        SITE_COORD: `'${lon},${lat},${alt}'`,
        START_TIME: `'${new Date(from).toISOString().slice(0, 16).replace('T', ' ')}'`,
        STOP_TIME: `'${new Date(to).toISOString().slice(0, 16).replace('T', ' ')}'`,
        STEP_SIZE: `'${step} m'`,
        QUANTITIES: globe ? "'4,13,14,15,20,32'" : "'4,13,20'",
        CSV_FORMAT: "'YES'",
        ANG_FORMAT: "'DEG'",
        TIME_DIGITS: "'SECONDS'",
        EXTRA_PREC: "'YES'",
      };
      const response = await fetch(
        'https://ssd.jpl.nasa.gov/api/horizons.api?' + new URLSearchParams(q),
        { signal: AbortSignal.timeout(60000) }
      );
      if (!response.ok) throw new Error('JPL Horizons is temporarily unavailable (' + response.status + ').');
      const data = await response.json();
      const body = data.result;
      if (data.error || !body?.includes('$$SOE')) {
        throw new Error('Horizons returned no ephemerides. Try another date range.');
      }
      const rows = body
        .split('$$SOE')[1]
        .split('$$EOE')[0]
        .trim()
        .split('\n')
        .map((line) => {
          const c = line.split(',').map((x) => x.trim());
          const t = Date.parse(c[0].replace(/(\d{4})-(\w{3})-(\d{2})/, '$3 $2 $1') + ' UTC');
          const row = [t, +c[3], +c[4], +c[5] / 3600, +c[globe ? 10 : 6] * 149597870.7];
          if (globe) {
            const angles = [6, 7, 8, 9, 12, 13].map((idx) => (c[idx] ? Number(c[idx]) : NaN));
            if (angles.every(Number.isFinite)) row.push(...angles);
          }
          return row;
        });
      if (!rows.length || rows.some((r) => r.some((v) => !Number.isFinite(v)))) {
        throw new Error('Unexpected Horizons response format.');
      }
      const expected = Math.round((to - from) / (step * 60000)) + 1;
      if (rows.length !== expected || rows[0][0] !== from || rows.at(-1)[0] !== to) {
        throw new Error('JPL Horizons returned an incomplete time series.');
      }
      return rows;
    };

    async function get(target) {
      const rows = [];
      const interval = step * 60000;
      const tasks = [];
      for (let i = 0; i < count; i += 8000) {
        tasks.push(
          getChunk(
            target,
            start + i * interval,
            start + Math.min(i + 8000, count) * interval
          ).then((chunk) => (i ? chunk.slice(1) : chunk))
        );
      }
      const chunks = await Promise.all(tasks);
      for (const chunk of chunks) rows.push(...chunk);
      return rows;
    }

    const [sun, earth] = await Promise.all([get(10), sunOnly ? Promise.resolve([]) : get(399)]);
    const result = {
      sun,
      earth,
      source: 'NASA/JPL Horizons',
      step,
      frame: 'MOON_ME / DE421',
      generated: new Date().toISOString(),
    };

    lruSet(ephemMemCache, cacheKey, result, 64);
    writeAtomic(cachePath, JSON.stringify(result)).catch(() => {});
    return result;
  })();

  ephemInFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    ephemInFlight.delete(cacheKey);
  }
}

const LOLA64_URL =
  'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img';
const LOLA64_BYTES = 23040 * 11520 * 2;

// Fetch only the selected columns of each row. Group ranges so the archive can
// serve hundreds of rows without hundreds of HTTP requests.
export async function readCompactArchiveWindow(
  url,
  { firstRow, rowCount, rowBytes, firstByte, bytesPerLine, fileBytes },
  fetcher = fetch
) {
  const linesPerRequest = 196;
  const output = new Uint8Array(rowCount * bytesPerLine);
  const batchCount = Math.ceil(rowCount / linesPerRequest);
  const controller = new AbortController();
  let nextBatch = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, batchCount) }, async () => {
        while (nextBatch < batchCount && !controller.signal.aborted) {
          const startLine = nextBatch++ * linesPerRequest;
          const endLine = Math.min(startLine + linesPerRequest, rowCount);
          const ranges = Array.from({ length: endLine - startLine }, (_, i) => {
            const start = (firstRow + startLine + i) * rowBytes + firstByte;
            return [start, start + bytesPerLine - 1];
          });
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(16000)]);
          const result = await fetcher(url, {
            headers: { Range: 'bytes=' + ranges.map((range) => range.join('-')).join(',') },
            signal,
          });
          const contentRange = result.headers.get('Content-Range');
          const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(
            result.headers.get('Content-Type') ?? ''
          );
          const single =
            ranges.length === 1 &&
            contentRange === `bytes ${ranges[0][0]}-${ranges[0][1]}/${fileBytes}`;
          if (result.status !== 206 || (!single && !boundary)) {
            await result.body?.cancel();
            throw new Error('Archive does not support compact elevation requests.');
          }
          const bytes = new Uint8Array(await result.arrayBuffer());
          if (single) {
            if (bytes.length !== bytesPerLine) throw new Error('Incomplete elevation row.');
            output.set(bytes, startLine * bytesPerLine);
            continue;
          }

          const marker = '--' + (boundary[1] ?? boundary[2]);
          const remaining = new Map(
            ranges.map(([start, end], i) => [`bytes ${start}-${end}/${fileBytes}`, i])
          );
          const decoder = new TextDecoder('ascii');
          let cursor = 0;
          while (remaining.size) {
            const headerStart = cursor;
            while (
              cursor + 3 < bytes.length &&
              cursor - headerStart < 1024 &&
              !(
                bytes[cursor] === 13 &&
                bytes[cursor + 1] === 10 &&
                bytes[cursor + 2] === 13 &&
                bytes[cursor + 3] === 10
              )
            ) {
              cursor++;
            }
            const header = decoder.decode(bytes.subarray(headerStart, cursor)).trimStart();
            const range = /^Content-Range:\s*(.+?)\s*$/im.exec(header)?.[1];
            const index = remaining.get(range);
            const bodyStart = cursor + 4;
            if (
              !header.startsWith(marker + '\r\n') ||
              index === undefined ||
              bodyStart + bytesPerLine > bytes.length
            ) {
              throw new Error('Invalid multipart elevation response.');
            }
            output.set(
              bytes.subarray(bodyStart, bodyStart + bytesPerLine),
              (startLine + index) * bytesPerLine
            );
            remaining.delete(range);
            cursor = bodyStart + bytesPerLine;
          }
        }
      })
    );
    return output;
  } finally {
    controller.abort();
  }
}

async function tryCompactArchiveWindow(url, window) {
  try {
    return await readCompactArchiveWindow(url, window);
  } catch {
    return undefined;
  }
}

export async function terrainDetail(url, { preferCompactRanges = false } = {}) {
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  if (
    !url.searchParams.has('lat') ||
    !url.searchParams.has('lon') ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return new Response('Invalid coordinates.', { status: 400 });
  }

  const detail = url.searchParams.get('detail') || 'regional';

  if (detail === 'stereo' && Math.abs(latitude) > 59.3) {
    return new Response(null, { status: 204 });
  }
  if (detail === 'landing' && Math.abs(latitude) >= 89.7) {
    return new Response(null, { status: 204 });
  }

  const tileKey = `${latitude.toFixed(3)}_${longitude.toFixed(3)}`;
  const memKey = `${detail}:${tileKey}`;

  const memHit = lruGet(tileMemCache, memKey);
  if (memHit) {
    return new Response(memHit.payload, { status: 200, headers: memHit.headers });
  }

  let pending = tileInFlight.get(memKey);
  if (!pending) {
    pending = (async () => {
      const cacheBinPath = path.join(CACHE_ROOT, 'tiles', detail, `${tileKey}.bin`);
      const cacheMetaPath = path.join(CACHE_ROOT, 'tiles', detail, `${tileKey}.json`);

      try {
        const [bin, metaRaw] = await Promise.all([
          fsp.readFile(cacheBinPath),
          fsp.readFile(cacheMetaPath, 'utf8'),
        ]);
        const parsedHeaders = JSON.parse(metaRaw);
        delete parsedHeaders['cache-control'];
        delete parsedHeaders['Cache-Control'];
        const headers = {
          ...parsedHeaders,
          'Cache-Control': 'public, max-age=604800',
        };
        const entry = { status: 200, payload: new Uint8Array(bin), headers };
        lruSet(tileMemCache, memKey, entry, 48);
        return entry;
      } catch {
        // Пропускаємо відсутній/пошкоджений кеш і завантажуємо
      }

      let response;
      if (detail === 'stereo') {
        response = await stereoTerrain(latitude, longitude, preferCompactRanges);
      } else if (detail === 'landing') {
        response = await fineTerrain(latitude, longitude, 1024, preferCompactRanges);
      } else if (detail === 'fine') {
        response = await fineTerrain(latitude, longitude, 256, preferCompactRanges);
      } else {
        response = await regionalTerrain(latitude, longitude, preferCompactRanges);
      }

      if (response.status === 200) {
        const payload = new Uint8Array(await response.arrayBuffer());
        const rawHeaders = Object.fromEntries(response.headers);
        delete rawHeaders['cache-control'];
        delete rawHeaders['Cache-Control'];
        const headers = {
          ...rawHeaders,
          'Cache-Control': 'public, max-age=604800',
        };
        const entry = { status: 200, payload, headers };
        lruSet(tileMemCache, memKey, entry, 48);
        Promise.all([
          writeAtomic(cacheBinPath, payload),
          writeAtomic(cacheMetaPath, JSON.stringify(headers)),
        ]).catch(() => {});
        return entry;
      }

      return { status: response.status, payload: null, headers: Object.fromEntries(response.headers) };
    })();

    const clearPending = () => {
      if (tileInFlight.get(memKey) === pending) tileInFlight.delete(memKey);
    };
    tileInFlight.set(memKey, pending);
    pending.then(clearPending, clearPending);
  }

  const result = await pending;
  return new Response(result.payload, { status: result.status, headers: result.headers });
}

async function regionalTerrain(latitude, longitude, preferCompactRanges = false) {
  const columns = 23040;
  const rows = 11520;
  const cellsPerDegree = 64;
  const radius = 1.75;
  const firstRow = Math.max(0, Math.floor((90 - latitude - radius) * cellsPerDegree) - 1);
  const lastRow = Math.min(rows - 1, Math.ceil((90 - latitude + radius) * cellsPerDegree));
  const rowCount = lastRow - firstRow + 1;
  const bytesPerRow = columns * 2;
  const poleward = Math.abs(latitude) + radius;
  const halfWidth =
    poleward >= 90
      ? columns / 2
      : Math.min(
          columns / 2,
          Math.ceil((radius * cellsPerDegree) / Math.cos((poleward * Math.PI) / 180)) + 2
        );
  const centerColumn = Math.floor((((longitude % 360) + 360) % 360) * cellsPerDegree);
  const firstColumn = (centerColumn - halfWidth + columns) % columns;
  const columnCount = Math.min(columns, halfWidth * 2 + 1);

  const start = firstRow * bytesPerRow;
  const end = (lastRow + 1) * bytesPerRow - 1;

  let band = null;
  const driveEntry = getDriveFileEntry(LWP_LDEM64_LOGICAL_PATH);
  const cachedDrivePath = getCachedFilePath(LWP_LDEM64_LOGICAL_PATH);

  const tryReadLocalLdem = async () => {
    for (const candidate of [LOCAL_LDEM64_PATH, LWP_LDEM64_LOCAL_PATH]) {
      try {
        const stat = await fsp.stat(candidate);
        if (stat.size === LOLA64_BYTES) {
          return await readFileRange(candidate, start, end);
        }
      } catch {
        // ignore missing local file
      }
    }
    return null;
  };

  if (preferLocalAssets()) {
    band = await tryReadLocalLdem();
  }

  if (!band && driveEntry) {
    try {
      const stat = await fsp.stat(cachedDrivePath);
      if (!driveEntry.size || stat.size === driveEntry.size) {
        band = await readFileRange(cachedDrivePath, start, end);
      }
    } catch {
      try {
        band = await readDriveRange(driveEntry.fileId, start, end);
      } catch {
        band = null;
      }
      if (!band || process.env.GDRIVE_PREFETCH_LDEM === '1') {
        ensureDriveFile(LWP_LDEM64_LOGICAL_PATH).catch((err) => {
          console.warn(`[gdrive] LDEM_64.IMG cache warmup failed: ${err.message}`);
        });
      }
    }
  }

  if (!band && !preferLocalAssets()) {
    band = await tryReadLocalLdem();
  }

  let tile = null;
  if (!band && preferCompactRanges && columnCount <= columns / 4 && firstColumn + columnCount <= columns) {
    tile = await tryCompactArchiveWindow(LOLA64_URL, {
      firstRow,
      rowCount,
      rowBytes: bytesPerRow,
      firstByte: firstColumn * 2,
      bytesPerLine: columnCount * 2,
      fileBytes: rows * bytesPerRow,
    });
  }

  if (!tile) {
    if (!band) {
      let upstreamOk = false;
      try {
        const upstream = await fetch(LOLA64_URL, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: AbortSignal.timeout(60000),
        });
        if (
          upstream.status === 206 &&
          upstream.headers.get('Content-Range') === `bytes ${start}-${end}/${rows * bytesPerRow}`
        ) {
          const fetched = new Uint8Array(await upstream.arrayBuffer());
          if (fetched.byteLength === rowCount * bytesPerRow) {
            band = fetched;
            upstreamOk = true;
          }
        } else {
          await upstream.body?.cancel();
        }
      } catch {
        upstreamOk = false;
      }
      if (!upstreamOk && driveEntry) {
        const downloaded = await ensureDriveFile(LWP_LDEM64_LOGICAL_PATH);
        if (downloaded?.path) {
          band = await readFileRange(downloaded.path, start, end);
        }
      }
      if (!band) {
        throw new Error('LOLA archive did not return the requested elevation tile.');
      }
      if (band.byteLength !== rowCount * bytesPerRow) {
        throw new Error('Incomplete LOLA elevation tile.');
      }
    }

    tile = new Uint8Array(rowCount * columnCount * 2);
    const leadingBytes = Math.min(columnCount, columns - firstColumn) * 2;
    for (let row = 0; row < rowCount; row++) {
      const rowStart = row * bytesPerRow;
      const segmentStart = rowStart + firstColumn * 2;
      const outputStart = row * columnCount * 2;
      tile.set(band.subarray(segmentStart, segmentStart + leadingBytes), outputStart);
      tile.set(
        band.subarray(rowStart, rowStart + columnCount * 2 - leadingBytes),
        outputStart + leadingBytes
      );
    }
  }

  return new Response(tile, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
      'X-LOLA-Grid': [firstRow, firstColumn, rowCount, columnCount].join(','),
    },
  });
}

async function fineTerrain(latitude, longitude, density = 256, preferCompactRanges = false) {
  const latitudeSpan = density === 1024 ? 15 : 90;
  const longitudeSpan = density === 1024 ? 30 : 180;
  const fileWidth = longitudeSpan * density;
  const fileHeight = latitudeSpan * density;
  const width = 360 * density;
  const height = 180 * density;
  const radius = density === 1024 ? 0.09 : 0.32;
  const firstRow = Math.max(0, Math.floor((90 - latitude - radius) * density) - 1);
  const lastRow = Math.min(height - 1, Math.ceil((90 - latitude + radius) * density));
  const rows = lastRow - firstRow + 1;
  const poleward = Math.abs(latitude) + radius;
  const halfWidth =
    poleward >= 90
      ? width / 2
      : Math.min(
          width / 2,
          Math.ceil((radius * density) / Math.cos((poleward * Math.PI) / 180)) + 2
        );
  const center = Math.floor(((longitude + 360) % 360) * density);
  const firstColumn = (center - halfWidth + width) % width;
  const columns = Math.min(width, halfWidth * 2 + 1);
  const tile = new Uint8Array(rows * columns * 2);
  const fileRowBytes = fileWidth * 2;

  const tasks = [];
  for (let row = firstRow; row <= lastRow; ) {
    const rowOffset = Math.floor(row / fileHeight) * fileHeight;
    const northLatitude = 90 - rowOffset / density;
    const rowEnd = Math.min(lastRow, rowOffset + fileHeight - 1);
    const startByte = (row - rowOffset) * fileRowBytes;
    const endByte = (rowEnd - rowOffset + 1) * fileRowBytes - 1;
    const bandRequests = new Map();

    for (let written = 0; written < columns; ) {
      const column = (firstColumn + written) % width;
      const tileColumn = Math.floor(column / fileWidth);
      const localColumn = column % fileWidth;
      const length = Math.min(columns - written, fileWidth - localColumn);

      const formatLat = (value) =>
        String(Math.abs(value)).padStart(2, '0') +
        (value < 0 || (value === 0 && northLatitude === 0) ? 's' : 'n');
      const latitudeTag = `${formatLat(northLatitude - latitudeSpan)}_${formatLat(northLatitude)}`;
      const longitudeLabel = (value) => String(value).padStart(3, '0');
      const longitudeTag = `${longitudeLabel(tileColumn * longitudeSpan)}_${longitudeLabel((tileColumn + 1) * longitudeSpan)}`;
      const source = LOLA64_URL.replace(
        'ldem_64.img',
        `ldem_${density}_${latitudeTag}_${longitudeTag}.img`
      );

      if (preferCompactRanges && length <= fileWidth / 4) {
        const currentRow = row;
        const currentRowEnd = rowEnd;
        const currentWritten = written;
        tasks.push(
          (async () => {
            const cropped = await tryCompactArchiveWindow(source, {
              firstRow: currentRow - rowOffset,
              rowCount: currentRowEnd - currentRow + 1,
              rowBytes: fileRowBytes,
              firstByte: localColumn * 2,
              bytesPerLine: length * 2,
              fileBytes: fileHeight * fileRowBytes,
            });
            if (cropped) {
              for (let line = currentRow; line <= currentRowEnd; line++) {
                const offset = (line - currentRow) * length * 2;
                tile.set(
                  cropped.subarray(offset, offset + length * 2),
                  ((line - firstRow) * columns + currentWritten) * 2
                );
              }
              return;
            }
            if (!bandRequests.has(tileColumn)) {
              bandRequests.set(
                tileColumn,
                fetch(source, {
                  headers: { Range: `bytes=${startByte}-${endByte}` },
                  signal: AbortSignal.timeout(60000),
                }).then(async (response) => {
                  if (
                    response.status !== 206 ||
                    response.headers.get('Content-Range') !==
                      `bytes ${startByte}-${endByte}/${fileHeight * fileRowBytes}`
                  ) {
                    await response.body?.cancel();
                    throw new Error('Could not retrieve detailed LOLA elevation data.');
                  }
                  const band = new Uint8Array(await response.arrayBuffer());
                  if (band.length !== endByte - startByte + 1) {
                    throw new Error('Incomplete LOLA elevation data.');
                  }
                  return band;
                })
              );
            }
            const band = await bandRequests.get(tileColumn);
            for (let line = currentRow; line <= currentRowEnd; line++) {
              const offset = (line - currentRow) * fileRowBytes + localColumn * 2;
              tile.set(
                band.subarray(offset, offset + length * 2),
                ((line - firstRow) * columns + currentWritten) * 2
              );
            }
          })()
        );
        written += length;
        continue;
      }

      if (!bandRequests.has(tileColumn)) {
        bandRequests.set(
          tileColumn,
          fetch(source, {
            headers: { Range: `bytes=${startByte}-${endByte}` },
            signal: AbortSignal.timeout(60000),
          }).then(async (response) => {
            if (
              response.status !== 206 ||
              response.headers.get('Content-Range') !==
                `bytes ${startByte}-${endByte}/${fileHeight * fileRowBytes}`
            ) {
              await response.body?.cancel();
              throw new Error('Could not retrieve detailed LOLA elevation data.');
            }
            const band = new Uint8Array(await response.arrayBuffer());
            if (band.length !== endByte - startByte + 1) {
              throw new Error('Incomplete LOLA elevation data.');
            }
            return band;
          })
        );
      }

      const sliceSpec = {
        bandPromise: bandRequests.get(tileColumn),
        row,
        rowEnd,
        localColumn,
        written,
        length,
      };
      tasks.push(
        (async () => {
          const band = await sliceSpec.bandPromise;
          for (let line = sliceSpec.row; line <= sliceSpec.rowEnd; line++) {
            const offset = (line - sliceSpec.row) * fileRowBytes + sliceSpec.localColumn * 2;
            tile.set(
              band.subarray(offset, offset + sliceSpec.length * 2),
              ((line - firstRow) * columns + sliceSpec.written) * 2
            );
          }
        })()
      );
      written += length;
    }
    row = rowEnd + 1;
  }

  await Promise.all(tasks);

  return new Response(tile, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
      'X-LOLA-Grid': [firstRow, firstColumn, rows, columns, density].join(','),
    },
  });
}

async function stereoTerrain(latitude, longitude, preferCompactRanges = false) {
  const density = 512;
  const radius = 0.6;
  const worldWidth = 360 * density;
  const firstRow = Math.floor((90 - latitude - radius) * density) - 1;
  const lastRow = Math.ceil((90 - latitude + radius) * density) + 1;
  const rows = lastRow - firstRow + 1;
  const half =
    Math.ceil((radius * density) / Math.cos(((Math.abs(latitude) + radius) * Math.PI) / 180)) + 2;
  const firstColumn =
    (((Math.floor(((longitude + 360) % 360) * density) - half) % worldWidth) + worldWidth) %
    worldWidth;
  const columns = 2 * half + 1;
  const output = new Uint8Array(rows * columns * 4);
  const fileWidth = 45 * density;
  const fileHeight = 30 * density;
  const rowBytes = fileWidth * 4;
  const latLabel = (v) => String(Math.abs(v)).padStart(2, '0') + (v < 0 ? 'S' : 'N');

  const segmentTasks = [];
  for (let row = firstRow; row <= lastRow; ) {
    const rowOffset = Math.floor(row / fileHeight) * fileHeight;
    const north = 90 - rowOffset / density;
    const south = north - 30;
    const northTag = north === 0 ? '00S' : latLabel(north);
    const southTag = south === 0 ? '00N' : latLabel(south);
    const endRow = Math.min(lastRow, rowOffset + fileHeight - 1);

    for (let written = 0; written < columns; ) {
      const col = (firstColumn + written) % worldWidth;
      const fileColumn = Math.floor(col / fileWidth);
      const localColumn = col % fileWidth;
      const length = Math.min(columns - written, fileWidth - localColumn);
      const west = String(fileColumn * 45).padStart(3, '0');
      const east = String((fileColumn + 1) * 45).padStart(3, '0');
      const tileUrl = `https://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/SLDEM2015_512_${southTag}_${northTag}_${west}_${east}_FLOAT.IMG`;
      const start = (row - rowOffset) * rowBytes;
      const end = (endRow - rowOffset + 1) * rowBytes - 1;
      const currentRow = row;
      const currentEndRow = endRow;
      const currentWritten = written;

      segmentTasks.push(
        (async () => {
          if (preferCompactRanges && length * 4 < rowBytes / 2) {
            try {
              const cropped = await readCompactArchiveWindow(tileUrl, {
                firstRow: currentRow - rowOffset,
                rowCount: currentEndRow - currentRow + 1,
                rowBytes,
                firstByte: localColumn * 4,
                bytesPerLine: length * 4,
                fileBytes: fileHeight * rowBytes,
              });
              for (let line = 0; line <= currentEndRow - currentRow; line++) {
                output.set(
                  cropped.subarray(line * length * 4, (line + 1) * length * 4),
                  ((currentRow - firstRow + line) * columns + currentWritten) * 4
                );
              }
              return;
            } catch {
              // Fall back to full-row range request if multipart ranges are rejected
            }
          }

          const response = await fetch(tileUrl, {
            headers: { Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(75000),
          });
          if (
            response.status !== 206 ||
            response.headers.get('Content-Range') !== `bytes ${start}-${end}/${fileHeight * rowBytes}`
          ) {
            await response.body?.cancel();
            throw new Error('SLDEM2015 stereo terrain is temporarily unavailable.');
          }
          const reader = response.body.getReader();
          let received = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunkStart = received;
            const chunkEnd = received + value.length;
            for (
              let line = Math.floor(chunkStart / rowBytes);
              line <= Math.floor((chunkEnd - 1) / rowBytes);
              line++
            ) {
              const begin = line * rowBytes + localColumn * 4;
              const finish = begin + length * 4;
              const left = Math.max(begin, chunkStart);
              const right = Math.min(finish, chunkEnd);
              if (left < right) {
                output.set(
                  value.subarray(left - chunkStart, right - chunkStart),
                  ((currentRow - firstRow + line) * columns + currentWritten) * 4 + left - begin
                );
              }
            }
            received = chunkEnd;
          }
          if (received !== end - start + 1) {
            throw new Error('Incomplete SLDEM2015 terrain band.');
          }
        })()
      );

      written += length;
    }
    row = endRow + 1;
  }

  await Promise.all(segmentTasks);

  return new Response(output, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
      'X-LOLA-Grid': [firstRow, firstColumn, rows, columns, density].join(','),
      'X-DEM-Format': 'float32-km',
      'X-DEM-Source': 'SLDEM2015',
    },
  });
}

export async function imageryTile(url) {
  const x = Number(url.searchParams.get('x'));
  const y = Number(url.searchParams.get('y'));
  const z = Number(url.searchParams.get('z') ?? 8);
  const projection = url.searchParams.get('projection') ?? 'EQ';
  const polar = projection === 'SP' || projection === 'NP';

  if (
    !['EQ', 'SP', 'NP'].includes(projection) ||
    !Number.isInteger(z) ||
    !(polar ? [2, 5] : [4, 8]).includes(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= 2 ** (z + 1) ||
    y < 0 ||
    y >= 2 ** z
  ) {
    return new Response('Invalid imagery tile.', { status: 400 });
  }

  const extension = polar ? 'png' : 'jpg';
  const contentType = polar ? 'image/png' : 'image/jpeg';
  const memKey = `${projection}:${z}:${x}:${y}`;
  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=604800',
  };

  const memHit = lruGet(imageryMemCache, memKey);
  if (memHit) {
    return new Response(memHit, { headers: responseHeaders });
  }

  let pending = imageryInFlight.get(memKey);
  if (!pending) {
    pending = (async () => {
      // 1. Для екваторіальних тайлів використовуємо Google Drive bundle або локальний LRO WAC (Z2–Z8)
      if (projection === 'EQ') {
        const tryLocalWac = async () => {
          const localWacPath = path.join(LOCAL_WAC_DIR, String(z), String(x), `${y}.jpg`);
          try {
            const data = await fsp.readFile(localWacPath);
            if (data.byteLength > 0) {
              return new Uint8Array(data);
            }
          } catch {
            return null;
          }
          return null;
        };

        if (preferLocalAssets()) {
          const localBytes = await tryLocalWac();
          if (localBytes) {
            lruSet(imageryMemCache, memKey, localBytes, 256);
            return localBytes;
          }
        }

        try {
          const driveBytes = await readLroWacTileFromDrive(z, x, y);
          if (driveBytes && driveBytes.byteLength > 0) {
            lruSet(imageryMemCache, memKey, driveBytes, 256);
            return driveBytes;
          }
        } catch {
          // Переходимо до локального/онлайн
        }

        if (!preferLocalAssets()) {
          const localBytes = await tryLocalWac();
          if (localBytes) {
            lruSet(imageryMemCache, memKey, localBytes, 256);
            return localBytes;
          }
        }
      }

      // 2. Перевіряємо дисковий кеш (зокрема для полярних SP/NP тайлів)
      const cachedTilePath = path.join(CACHE_ROOT, 'imagery', projection, String(z), String(x), `${y}.${extension}`);
      try {
        const data = await fsp.readFile(cachedTilePath);
        if (data.byteLength > 0) {
          const bytes = new Uint8Array(data);
          lruSet(imageryMemCache, memKey, bytes, 256);
          return bytes;
        }
      } catch {
        // Пропускаємо відсутній/пошкоджений кеш
      }

      const product = polar
        ? `LRO_WAC_Mosaic_${projection[0]}Pole60_100m_v02`
        : 'LRO_WAC_Mosaic_Global_303ppd_v02';
      const source = `https://trek.nasa.gov/tiles/Moon/${projection}/${product}/1.0.0/default/default028mm/${z}/${y}/${x}.${extension}`;
      const response = await fetch(source, { signal: AbortSignal.timeout(25000) });
      if (!response.ok || !response.headers.get('Content-Type')?.includes('image')) {
        await response.body?.cancel();
        return null;
      }

      const buf = new Uint8Array(await response.arrayBuffer());
      lruSet(imageryMemCache, memKey, buf, 256);
      writeAtomic(cachedTilePath, buf).catch(() => {});
      return buf;
    })();

    const clearPending = () => {
      if (imageryInFlight.get(memKey) === pending) imageryInFlight.delete(memKey);
    };
    imageryInFlight.set(memKey, pending);
    pending.then(clearPending, clearPending);
  }

  const buf = await pending;
  if (!buf) {
    return new Response('Orbital imagery unavailable.', { status: 502 });
  }
  return new Response(buf, { headers: responseHeaders });
}
