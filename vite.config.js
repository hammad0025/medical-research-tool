import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createResearchApiPlugin } from './server/researchApi.mjs'

export default defineConfig(({ mode }) => {
  // Server-only values are read here; VITE_ variables are never used for API keys.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), createResearchApiPlugin(env)],
  }
})
