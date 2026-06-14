import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// M16-G1: stamp the build with a timestamp + short git sha so we can
// confirm from the console (`window.__RA_BUILD__`) which bundle is
// actually live. Falls back gracefully if git isn't available.
const BUILD_TIME = new Date().toISOString()
let BUILD_SHA = 'unknown'
try {
  BUILD_SHA = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch {
  BUILD_SHA = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'no-git'
}

export default defineConfig({
  plugins: [react()],
  define: {
    __RA_BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __RA_BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  server: {
    port: 5173,
    host: true,
    strictPort: false
  },
  build: {
    rollupOptions: {
      output: {
        // Pull the heavy data files into their own chunks so the
        // initial JS bundle stays small. Each gate's passages and
        // the assessment-item bank only fetch when their route opens.
        manualChunks(id) {
          if (id.includes('src/data/passages.json')) return 'data-passages';
          if (id.includes('src/data/assessment_items.json')) return 'data-items';
          if (id.includes('src/data/skill_nodes.json')) return 'data-skills';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
