import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/main'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'workers/conversion.worker': 'src/main/workers/conversion.worker.ts',
          'workers/preview.worker': 'src/main/workers/preview.worker.ts'
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'chunks/[name]-[hash][extname]'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: resolve(__dirname, 'dist/preload'),
      emptyOutDir: true
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
});
