import {
  DEFAULT_JOBS_DIR,
  TrajectoryServiceError,
  getTrajectoryCatalog,
  getTrajectoryJobResult,
  getTrajectoryJobStatus,
  submitTrajectoryJob,
} from './service.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

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

export function createTrajectoryMiddleware({
  jobsDir = DEFAULT_JOBS_DIR,
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
