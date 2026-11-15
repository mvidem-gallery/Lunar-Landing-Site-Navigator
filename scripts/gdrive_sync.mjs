#!/usr/bin/env node
import fs from 'node:fs';
import {
  ensureBundleIndex,
  ensureBundleTar,
  ensureDriveFile,
  getBundlePaths,
  getCacheRoot,
  getCachedFilePath,
  getManifestPath,
  loadDriveManifest,
} from '../src/gdrive/driveClient.mjs';

function parseArgs(argv) {
  const opts = {
    all: false,
    withTiles: false,
    verifyOnly: false,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--with-tiles') opts.withTiles = true;
    else if (a === '--verify') opts.verifyOnly = true;
    else if (a === '--only' && argv[i + 1]) {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log(`
Google Drive Cache Sync

Usage:
  node scripts/gdrive_sync.mjs [options]

Options:
  --all          Download all manifest files and all LRO WAC tile bundles (Z2-Z8)
  --with-tiles   Include LRO WAC .tar bundles (default: indices only, plus Z2-Z6)
  --only <list>  Filter logical paths / bundle keys (comma-separated)
  --verify       Check manifest & local cache status without downloading
`.trim());
      process.exit(0);
    }
  }
  return opts;
}

function matches(filters, text) {
  if (!filters || filters.length === 0) return true;
  const hay = text.toLowerCase();
  return filters.some((f) => hay.includes(f));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadDriveManifest({ force: true });
  const fileEntries = Object.entries(manifest.files || {});
  const bundleEntries = Object.entries(manifest.bundles || {});

  console.log(`[gdrive_sync] Manifest: ${getManifestPath()}`);
  console.log(`[gdrive_sync] Cache dir: ${getCacheRoot()}`);
  console.log(`[gdrive_sync] Registered files: ${fileEntries.length}, bundles: ${bundleEntries.length}`);

  if (fileEntries.length === 0 && bundleEntries.length === 0) {
    console.log('[gdrive_sync] Manifest is currently empty. Run `npm run gdrive:upload` first to populate Google Drive.');
    return;
  }

  for (const [logicalPath, entry] of fileEntries) {
    if (!matches(opts.only, `${entry.category || ''} ${logicalPath}`)) continue;
    const target = getCachedFilePath(logicalPath);
    const exists = fs.existsSync(target);
    if (opts.verifyOnly) {
      console.log(`  [${exists ? 'CACHED' : 'REMOTE'}] ${logicalPath}`);
      continue;
    }
    const res = await ensureDriveFile(logicalPath);
    console.log(`  [${res?.fromCache ? 'CACHED' : 'DOWNLOADED'}] ${logicalPath}`);
  }

  for (const [bundleKey, meta] of bundleEntries) {
    if (!matches(opts.only, `tiles ${bundleKey}`)) continue;
    const bundleMeta = { bundleKey, ...meta };
    const { tarPath, indexPath } = getBundlePaths(bundleKey);
    if (opts.verifyOnly) {
      console.log(
        `  [BUNDLE ${bundleKey}] idx=${fs.existsSync(indexPath) ? 'CACHED' : 'REMOTE'}, tar=${fs.existsSync(tarPath) ? 'CACHED' : 'REMOTE'}`
      );
      continue;
    }
    await ensureBundleIndex(bundleMeta);
    const isLargeZoom = Array.isArray(meta.zooms) && meta.zooms.some((z) => z >= 7);
    if (opts.all || opts.withTiles || !isLargeZoom) {
      await ensureBundleTar(bundleMeta);
      console.log(`  [BUNDLE READY] ${bundleKey}.tar`);
    } else {
      console.log(`  [INDEX READY] ${bundleKey}.tar.idx.gz (skipped large tar; pass --all or --with-tiles to pre-cache)`);
    }
  }
}

main().catch((err) => {
  console.error(`[gdrive_sync] ERROR: ${err?.message || err}`);
  process.exit(1);
});
