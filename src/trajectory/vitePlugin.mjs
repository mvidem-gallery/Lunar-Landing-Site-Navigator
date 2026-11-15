import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getCachedFilePath, loadDriveManifest } from '../gdrive/driveClient.mjs';
import {
  DEFAULT_JOBS_DIR,
  PROJECT_ROOT,
  TrajectoryServiceError,
  getTrajectoryCatalog,
  getTrajectoryJobResult,
  getTrajectoryJobStatus,
  submitTrajectoryJob,
} from './service.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_TRAJECTORIES_DIR = path.join(PROJECT_ROOT, 'public', 'trajectories');

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof TrajectoryServiceError) {
    sendJson(res, err.statusCode || 500, {
      ok: false,
      error: {
        code: err.code || 'internal',
        message: err.message,
      },
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    error: {
      code: 'internal',
      message: err?.message || 'Unexpected trajectory service failure.',
    },
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new TrajectoryServiceError('Request payload too large', {
        statusCode: 413,
        code: 'bad_request',
      });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new TrajectoryServiceError(`Invalid JSON body: ${err.message}`, {
      statusCode: 400,
      code: 'bad_request',
    });
  }
}

async function summarizeTrajectoryFile(filePath, fileName, source = 'local') {
  const url = `/trajectories/${encodeURIComponent(fileName)}`;
  const fallback = {
    fileName,
    url,
    source,
    createdUtc: null,
    rocket: null,
    spaceportName: null,
    launchUtc: null,
    touchdownUtc: null,
    durationSec: null,
    landingLatDeg: null,
    landingLonDeg: null,
    totalDeltaVKmS: null,
  };
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return fallback;
    const entries = Array.isArray(doc.trajectories) ? doc.trajectories : [];
    const firstTraj =
      entries.find((t) => t && t.source !== 'none' && Array.isArray(t.samples) && t.samples.length >= 2) ||
      entries.find((t) => t && t.source !== 'none') ||
      entries[0] ||
      null;

    let totalDvKmS = 0;
    let hasDv = false;
    for (const ev of firstTraj?.events || []) {
      if (Array.isArray(ev?.delta_v) && ev.delta_v.length >= 3) {
        const dv = Math.hypot(
          Number(ev.delta_v[0]) || 0,
          Number(ev.delta_v[1]) || 0,
          Number(ev.delta_v[2]) || 0
        );
        if (Number.isFinite(dv) && dv > 0) {
          totalDvKmS += dv;
          hasDv = true;
        }
      }
    }

    const latRaw = doc.landing_site?.lat_deg ?? firstTraj?.end?.lat_deg;
    const lonRaw = doc.landing_site?.lon_deg ?? firstTraj?.end?.lon_deg;
    const durRaw = firstTraj?.end?.t_s;

    return {
      fileName,
      url,
      source,
      createdUtc: typeof doc.created_utc === 'string' ? doc.created_utc : null,
      rocket: typeof firstTraj?.rocket === 'string' ? firstTraj.rocket : null,
      spaceportName: typeof firstTraj?.spaceport_name === 'string' ? firstTraj.spaceport_name : null,
      launchUtc: typeof firstTraj?.start?.t === 'string' ? firstTraj.start.t : null,
      touchdownUtc: typeof firstTraj?.end?.t === 'string' ? firstTraj.end.t : null,
      durationSec: Number.isFinite(Number(durRaw)) ? Math.round(Number(durRaw)) : null,
      landingLatDeg: Number.isFinite(Number(latRaw)) ? Number(latRaw) : null,
      landingLonDeg: Number.isFinite(Number(lonRaw)) ? Number(lonRaw) : null,
      totalDeltaVKmS: hasDv ? Number(totalDvKmS.toFixed(3)) : null,
    };
  } catch {
    return fallback;
  }
}

export async function listTrajectoryFiles({ trajectoriesDir = DEFAULT_TRAJECTORIES_DIR } = {}) {
  const byFileName = new Map();

  if (trajectoriesDir && fs.existsSync(trajectoriesDir)) {
    const entries = await fsp.readdir(trajectoriesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const fullPath = path.join(trajectoriesDir, entry.name);
      const summary = await summarizeTrajectoryFile(fullPath, entry.name, 'local');
      byFileName.set(entry.name, summary);
    }
  }

  try {
    const manifest = loadDriveManifest();
    for (const [logicalPath, entry] of Object.entries(manifest?.files || {})) {
      const m = /^public\/trajectories\/([^/]+\.json)$/i.exec(logicalPath);
      if (!m || !entry?.fileId) continue;
      const fileName = m[1];
      if (byFileName.has(fileName)) continue;
      const cachedPath = getCachedFilePath(logicalPath);
      const summary = await summarizeTrajectoryFile(cachedPath, fileName, 'drive');
      byFileName.set(fileName, summary);
    }
  } catch {
    // Ignore Drive manifest issues if unavailable
  }

  return Array.from(byFileName.values()).sort((a, b) => {
    const tA = a.createdUtc ? Date.parse(a.createdUtc.replace(' UTC', 'Z')) : 0;
    const tB = b.createdUtc ? Date.parse(b.createdUtc.replace(' UTC', 'Z')) : 0;
    if (Number.isFinite(tA) && Number.isFinite(tB) && tA !== tB) {
      return tB - tA;
    }
    return a.fileName.localeCompare(b.fileName);
  });
}

export function createTrajectoryMiddleware({
  jobsDir = DEFAULT_JOBS_DIR,
  trajectoriesDir = DEFAULT_TRAJECTORIES_DIR,
  runnerOverride = null,
} = {}) {
  return async function trajectoryMiddleware(req, res, next) {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (method === 'GET' && pathname === '/catalog') {
        const data = await getTrajectoryCatalog({ runnerOverride });
        sendJson(res, 200, data);
        return;
      }

      if (method === 'GET' && pathname === '/files') {
        const files = await listTrajectoryFiles({ trajectoriesDir });
        sendJson(res, 200, { ok: true, files });
        return;
      }

      if (method === 'POST' && pathname === '/jobs') {
        const body = await readJsonBody(req);
        const wait = Boolean(body?.wait);
        const payload = { ...body };
        delete payload.wait;
        const result = await submitTrajectoryJob(payload, {
          wait,
          jobsDir,
          runnerOverride,
        });
        sendJson(res, wait ? 200 : 202, result);
        return;
      }

      const jobMatch = /^\/jobs\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const data = await getTrajectoryJobStatus(jobId, { jobsDir, runnerOverride });
        sendJson(res, 200, data);
        return;
      }

      const resultMatch = /^\/jobs\/([^/]+)\/result$/.exec(pathname);
      if (method === 'GET' && resultMatch) {
        const jobId = decodeURIComponent(resultMatch[1]);
        const part = url.searchParams.get('part') || 'all';
        const data = await getTrajectoryJobResult(jobId, {
          part,
          jobsDir,
          runnerOverride,
        });
        sendJson(res, 200, data);
        return;
      }

      if (next) {
        next();
      } else {
        sendJson(res, 404, {
          ok: false,
          error: { code: 'not_found', message: `Unknown trajectory endpoint: ${pathname}` },
        });
      }
    } catch (err) {
      sendError(res, err);
    }
  };
}

export function trajectoryServicePlugin(options = {}) {
  const middleware = createTrajectoryMiddleware(options);
  return {
    name: 'lwp-trajectory-service',
    configureServer(server) {
      server.middlewares.use('/api/trajectory', middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/trajectory', middleware);
    },
  };
}
