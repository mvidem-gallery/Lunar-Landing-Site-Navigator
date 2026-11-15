import { defineConfig } from 'vite';
import { PROXY_CONFIG } from './src/config/constants.js';
import { lunarHorizonPlugin } from './src/lunar-horizon/vitePlugin.mjs';
import { trajectoryServicePlugin } from './src/trajectory/vitePlugin.mjs';
import { reportServicePlugin } from './src/report/vitePlugin.mjs';

export default defineConfig({
  plugins: [lunarHorizonPlugin(), trajectoryServicePlugin(), reportServicePlugin()],
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
