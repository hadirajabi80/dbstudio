import { defineConfig } from 'vitest/config';

// IntelliSense engine tests (pure TypeScript, node environment). Run: npm run test:intel
export default defineConfig({
  test: {
    include: ['src/intel/**/*.test.ts', 'src/editor/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
  },
});
