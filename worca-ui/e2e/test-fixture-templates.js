import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

test('verify templates endpoint works', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create test template at project tier
    mkdirSync(join(ctx.dir, '.claude', 'templates', 'test-one'), { recursive: true });
    writeFileSync(
      join(ctx.dir, '.claude', 'templates', 'test-one', 'template.json'),
      JSON.stringify({ id: 'test-one', name: 'Test', config: {} }, null, 2)
    );
    
    console.log('Created template');
    console.log('Fetching templates from:', `${ctx.url}/api/templates`);
    
    const response = await fetch(`${ctx.url}/api/templates`);
    const data = await response.json();
    
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));
  } finally {
    await ctx.close();
  }
});
