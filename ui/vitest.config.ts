import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// App shell tests (WP-C). IntelliSense/editor tests run with `npm run test:intel` (vitest.intel.config.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'src/intel/**', 'src/editor/**'],
    css: false,
    testTimeout: 15000,
  },
})
