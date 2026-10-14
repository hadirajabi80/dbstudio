import { defineConfig } from 'vitest/config';

// IntelliSense engine, editor core, formatter and snippet tests (pure TypeScript, node environment).
// Run: npm run test:intel
export default defineConfig({
  test: {
    include: [
      'src/intel/**/*.test.ts',
      'src/editor/**/*.test.ts',
      'src/format/**/*.test.ts',
      'src/snippets/**/*.test.ts',
    ],
    environment: 'node',
    pool: 'threads',
  },
});
