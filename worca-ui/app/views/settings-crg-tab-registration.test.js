import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('CRG tab registration in settings.js', () => {
  const settingsSource = readFileSync(join(__dirname, 'settings.js'), 'utf-8');

  it('imports crgTab from settings-code-review-graph.js', () => {
    expect(settingsSource).toContain(
      "import { crgTab } from './settings-code-review-graph.js'",
    );
  });

  it('registers a Code Review Graph tab in the sl-tab-group', () => {
    expect(settingsSource).toContain('panel="code-review-graph"');
    expect(settingsSource).toContain('Code Review Graph');
  });

  it('registers a Code Review Graph tab panel', () => {
    expect(settingsSource).toContain('name="code-review-graph"');
    expect(settingsSource).toContain('crgTab(');
  });

  it('places the CRG tab after the Graphify tab', () => {
    const graphifyTabIdx = settingsSource.indexOf('panel="graphify"');
    const crgTabIdx = settingsSource.indexOf('panel="code-review-graph"');
    expect(graphifyTabIdx).toBeGreaterThan(-1);
    expect(crgTabIdx).toBeGreaterThan(-1);
    expect(crgTabIdx).toBeGreaterThan(graphifyTabIdx);
  });
});
