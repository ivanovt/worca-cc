import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude Playwright e2e tests from Vitest runs
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    coverage: {
      // v8 is built into Node — no native deps, fast.
      provider: 'v8',
      reporter: ['text', 'json-summary', 'cobertura'],
      reportsDirectory: './coverage-out',
      // Mirror the Python side's intent: measure source, ignore tests + generated.
      include: ['app/**/*.js', 'server/**/*.js', 'bin/**/*.js'],
      exclude: [
        '**/*.test.js',
        '**/test/**',
        'app/main.bundle.js',
        'app/main.bundle.js.map',
        'app/vendor/**',
        'scripts/**',
        'e2e/**',
      ],
    },
  },
});
