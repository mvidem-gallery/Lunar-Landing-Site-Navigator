import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_REPORT_ROOT = path.join(PROJECT_ROOT, 'report', 'lunar-report-dss');
const WORKER_SCRIPT = path.join(__dirname, 'reportWorker.mjs');
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      const err = new Error('REQUEST_BODY_TOO_LARGE');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('INVALID_JSON');
    err.statusCode = 400;
    throw err;
  }
}

export function createReportMiddleware({
  reportRoot = DEFAULT_REPORT_ROOT,
  upstreamUrl = process.env.REPORT_API_URL || '',
} = {}) {
  let worker = null;
  let workerReadyPromise = null;
  let reqCounter = 0;
  const pending = new Map();

  function cleanupWorker(reason = 'Worker closed') {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
    worker = null;
    workerReadyPromise = null;
  }

  function ensureWorker() {
    if (worker && workerReadyPromise) return workerReadyPromise;

    workerReadyPromise = new Promise((resolve, reject) => {
      if (!fs.existsSync(reportRoot)) {
        reject(new Error(`Report service directory not found: ${reportRoot}`));
        return;
      }

      const child = fork(WORKER_SCRIPT, [], {
        cwd: reportRoot,
        execArgv: [],
        env: {
          ...process.env,
          REPORT_ROOT_DIR: reportRoot,
          NASA_PROJECT_ROOT: PROJECT_ROOT,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      worker = child;

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log(`[report-dss] ${text}`);
      });
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[report-dss] ${text}`);
      });

      const startupTimer = setTimeout(() => {
        reject(new Error('Report worker startup timeout'));
      }, 15_000);

      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          clearTimeout(startupTimer);
          resolve(child);
          return;
        }
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve({
          statusCode: msg.statusCode || 200,
          payload: msg.payload,
        });
      });

      child.on('exit', (code) => {
        clearTimeout(startupTimer);
        if (worker === child) {
          cleanupWorker(`Report worker exited with code ${code}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(startupTimer);
        if (worker === child) {
          cleanupWorker(err.message);
        }
        reject(err);
      });
    });

    return workerReadyPromise;
  }

  async function callWorker(type, body = null) {
    const child = await ensureWorker();
    const id = ++reqCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('REPORT_GENERATION_TIMEOUT'));
      }, 90_000);

      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, body });
    });
  }

  async function forwardToUpstream(method, body) {
    const base = upstreamUrl.replace(/\/+$/, '');
    const target = `${base}/api/mission-report`;
    const res = await fetch(target, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text || `HTTP_${res.status}` };
    }
    return { statusCode: res.status, payload: json };
  }

  const middleware = async function reportMiddleware(req, res, next) {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (method === 'GET' && (pathname === '/' || pathname === '' || pathname === '/health')) {
        const result = await callWorker('health');
        sendJson(res, result.statusCode, {
          ...result.payload,
          upstreamConfigured: Boolean(upstreamUrl),
        });
        return;
      }

      if (method === 'POST' && (pathname === '/' || pathname === '')) {
        const body = await readJsonBody(req);
        if (upstreamUrl) {
          try {
            const upstreamResult = await forwardToUpstream('POST', body);
            sendJson(res, upstreamResult.statusCode, upstreamResult.payload);
            return;
          } catch (upstreamErr) {
            console.warn(
              '[report-dss] Upstream unavailable, falling back to local report engine:',
              upstreamErr.message
            );
          }
        }
        const result = await callWorker('generate', body);
        sendJson(res, result.statusCode, result.payload);
        return;
      }

      if (next) {
        next();
      } else {
        sendJson(res, 404, { error: `Unknown mission-report endpoint: ${pathname}` });
      }
    } catch (err) {
      sendJson(res, err?.statusCode || 500, {
        error: err?.message || 'INTERNAL_REPORT_ERROR',
      });
    }
  };

  middleware.dispose = () => {
    if (worker) {
      try {
        worker.kill();
      } catch {
        // ignore
      }
      cleanupWorker('Server shutting down');
    }
  };

  return middleware;
}

export function reportServicePlugin(options = {}) {
  const middleware = createReportMiddleware(options);
  return {
    name: 'lunar-report-dss-service',
    configureServer(server) {
      server.middlewares.use('/api/mission-report', middleware);
      server.httpServer?.once('close', () => middleware.dispose());
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/mission-report', middleware);
      server.httpServer?.once('close', () => middleware.dispose());
    },
  };
}
