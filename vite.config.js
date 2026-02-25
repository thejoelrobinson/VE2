import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/VE2/',
  server: {
    port: 5174,
    open: false,
    https: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  worker: {
    format: 'es'
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        popout: resolve(__dirname, 'popout.html')
      }
    }
  }
});
