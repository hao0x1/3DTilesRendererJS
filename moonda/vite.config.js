import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '..');

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: '3d-tiles-renderer/three/plugins', replacement: path.join(repoRoot, 'src/three/plugins/index.js') },
      { find: '3d-tiles-renderer/core/plugins', replacement: path.join(repoRoot, 'src/core/plugins/index.js') },
      { find: '3d-tiles-renderer/three', replacement: path.join(repoRoot, 'src/three/renderer/index.js') },
      { find: '3d-tiles-renderer/core', replacement: path.join(repoRoot, 'src/core/renderer/index.js') },
    ],
    dedupe: ['three', 'react', 'react-dom', 'pbf', 'pmtiles', '@mapbox/vector-tile'],
  },
  server: { fs: { allow: [repoRoot] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 750,
    rollupOptions: { output: { manualChunks(id) {
      if (id.includes('/node_modules/three/')) return 'three';
      if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
    } } },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
