import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: false,
    watch: {
      // OneDrive + smoke/thumbnail writes can trigger EBUSY on file watchers.
      ignored: ['**/_tmp_smoke/**', '**/_tmp_thumbs/**'],
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // The three.js vendor chunk alone is ~507 kB minified (129 kB gzip).
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Three.js is ~90% of the bundle; keep it in its own long-lived chunk.
        manualChunks: { three: ['three'] },
      },
    },
  },
  test: {
    // src/core, utils and the camera director are DOM-free by design and run under plain Node.
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
