import { describe, expect, it } from 'vitest';

describe('secrets-modal exports', () => {
  it('exports openSecretsModal as a function', async () => {
    const mod = await import('./secrets-modal.js');
    expect(typeof mod.openSecretsModal).toBe('function');
  });

  it('exports closeSecretsModal as a function', async () => {
    const mod = await import('./secrets-modal.js');
    expect(typeof mod.closeSecretsModal).toBe('function');
  });

  it('exports secretsModalTemplate as a function', async () => {
    const mod = await import('./secrets-modal.js');
    expect(typeof mod.secretsModalTemplate).toBe('function');
  });

  it('secretsModalTemplate returns nothing when no model is active', async () => {
    const mod = await import('./secrets-modal.js');
    const result = mod.secretsModalTemplate(null, () => {});
    // lit-html `nothing` is a symbol
    expect(
      typeof result === 'symbol' ||
        result === undefined ||
        result === null ||
        result === '',
    ).toBe(true);
  });
});
