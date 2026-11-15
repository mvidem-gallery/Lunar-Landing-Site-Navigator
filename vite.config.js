import { defineConfig } from 'vite';
import { PROXY_CONFIG } from './src/config/constants.js';
import { lunarHorizonPlugin } from './src/lunar-horizon/vitePlugin.mjs';

export default defineConfig({
  plugins: [lunarHorizonPlugin()],
  server: {
    watch: {
      // Виключаємо десятки тисяч локальних тайлів і сирі архіви DEM із file-watcher Vite
      ignored: ['**/public/tiles/**', '**/tiles/**', '**/lunar-horizon-latest/**'],
    },
    proxy: {
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
    },
  },
});
