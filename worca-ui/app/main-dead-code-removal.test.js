/**
 * Verifies that the dead Branch A handlers and the global pipelineAction flag
 * have been removed from main.js after the migration to per-run _controlPending.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'main.js'), 'utf8');

describe('dead Branch A code removal', () => {
  it('no global pipelineAction declaration', () => {
    expect(source).not.toMatch(/^let pipelineAction\b/m);
  });

  it('no pipelineAction assignments anywhere', () => {
    expect(source).not.toMatch(/pipelineAction\s*=/);
  });

  it('no pipelineAction reads anywhere', () => {
    expect(source).not.toContain('pipelineAction');
  });

  it('handleConfirmStop is removed', () => {
    expect(source).not.toMatch(/function handleConfirmStop\b/);
  });

  it('handleStopPipeline is removed', () => {
    expect(source).not.toMatch(/function handleStopPipeline\b/);
  });

  it('handlePausePipeline is removed', () => {
    expect(source).not.toMatch(/function handlePausePipeline\b/);
  });

  it('handleResumePipeline is removed', () => {
    expect(source).not.toMatch(/function handleResumePipeline\b/);
  });

  it('_controlPending is still present (Branch B replacement)', () => {
    expect(source).toMatch(/^let _controlPending\b/m);
  });
});
