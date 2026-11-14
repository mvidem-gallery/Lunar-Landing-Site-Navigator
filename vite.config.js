import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      // Виключаємо десятки тисяч локальних тайлів із file-watcher Vite
      ignored: ['**/public/tiles/**', '**/tiles/**'],
    },
    proxy: {
      '/opm-tiles': {
        target: 'https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opm-tiles/, '')
      }
    }
  }
});