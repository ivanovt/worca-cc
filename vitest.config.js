export default {
  test: {
    // Exclude Playwright e2e tests (must run via `npx playwright test`)
    exclude: ['**/node_modules/**', '**/dist/**', 'worca-ui/e2e/**'],
  },
};
