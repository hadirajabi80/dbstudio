import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `vite --mode mock` (npm run dev:mock): the UI talks to the in-page fake engine in src/mocks (MSW handlers +
// a fake WebSocket). Every other mode talks to a real engine: VITE_ENGINE_URL / VITE_ENGINE_TOKEN in the
// browser, the preload bridge in Electron.
export default defineConfig({
  // Relative asset URLs: the Electron build is served from dbstudio://app/.
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
})
