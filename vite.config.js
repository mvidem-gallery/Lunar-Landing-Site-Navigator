import { defineConfig } from 'vite';
import { PROXY_CONFIG } from './src/config/constants.js';
import { gdriveAssetsPlugin } from './src/gdrive/vitePlugin.mjs';
import { lunarHorizonPlugin } from './src/lunar-horizon/vitePlugin.mjs';
import { trajectoryServicePlugin } from './src/trajectory/vitePlugin.mjs';
import { reportServicePlugin } from './src/report/vitePlugin.mjs';

const sharedProxy = {
  [PROXY_CONFIG.OPM_TILES_PATH]: {
    target: PROXY_CONFIG.OPM_TILES_TARGET,
    changeOrigin: true,
    rewrite: (path) => path.replace(new RegExp(`^${PROXY_CONFIG.OPM_TILES_PATH}`), ''),
  },
  [PROXY_CONFIG.HORIZONS_API_PATH]: {
    target: PROXY_CONFIG.HORIZONS_API_TARGET,
    changeOrigin: true,
    rewrite: (path) =>
      path.replace(
        new RegExp(`^${PROXY_CONFIG.HORIZONS_API_PATH}`),
        PROXY_CONFIG.HORIZONS_API_REWRITE_PATH
      ),
  },
};

export default defineConfig({
  base: process.env.VITE_BASE || './',
  plugins: [
    gdriveAssetsPlugin(),
    lunarHorizonPlugin(),
    trajectoryServicePlugin(),
    reportServicePlugin(),
  ],
  build: {
    copyPublicDir: process.env.GDRIVE_PREFER_LOCAL === '1',
  },
  server: {
    watch: {
      // Виключаємо десятки тисяч локальних тайлів, сирі архіви DEM і папки задач генератора траєкторій із file-watcher Vite
      ignored: [
        '**/public/tiles/**',
        '**/tiles/**',
        '**/lunar-horizon-latest/**',
        '**/trajectory/**/jobs/**',
        '**/cache/**',
        '**/report/**/.next/**',
      ],
    },
    proxy: sharedProxy,
  },
  preview: {
    allowedHosts: true,
    proxy: sharedProxy,
  },
});
