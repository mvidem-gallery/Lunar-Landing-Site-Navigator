import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DATATABLE_DIR = path.join(PROJECT_ROOT, 'Datatable/Datatable');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const STATIC_FILES = [
  'index.html',
  'styles.css',
  'js/parser.js',
  'js/store.js',
  'js/datatable.js',
  'js/app.js',
];

export function datatablePlugin() {
  return {
    name: 'lwp-datatable-integration',

    configureServer(server) {
      server.middlewares.use('/datatable', (req, res, next) => {
        try {
          const originalUrl = req.originalUrl || req.url || '/';
          const parsedOriginal = new URL(originalUrl, 'http://localhost');

          if (parsedOriginal.pathname === '/datatable') {
            res.writeHead(302, { Location: `/datatable/${parsedOriginal.search}` });
            res.end();
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const pathname = url.pathname;
          const rel =
            pathname === '/' || pathname === '/index.html'
              ? 'index.html'
              : pathname.replace(/^\/+/, '');

          if (rel.includes('..') || !STATIC_FILES.includes(rel)) {
            next();
            return;
          }

          const filePath = path.join(DATATABLE_DIR, rel);
          if (!fs.existsSync(filePath)) {
            next();
            return;
          }

          const ext = path.extname(filePath);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          });
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err?.message || 'Internal Datatable error.' }));
        }
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use('/datatable', (req, res, next) => {
        const originalUrl = req.originalUrl || req.url || '/';
        const parsedOriginal = new URL(originalUrl, 'http://localhost');
        if (parsedOriginal.pathname === '/datatable') {
          res.writeHead(302, { Location: `/datatable/${parsedOriginal.search}` });
          res.end();
          return;
        }
        next();
      });
    },

    writeBundle(outputOptions) {
      const outDir = outputOptions.dir || path.join(PROJECT_ROOT, 'dist');
      const targetDir = path.join(outDir, 'datatable');

      for (const rel of STATIC_FILES) {
        const srcPath = path.join(DATATABLE_DIR, rel);
        if (!fs.existsSync(srcPath)) continue;
        const destPath = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
    },
  };
}
