import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPromptsModel,
  classifyPromptFile,
  parseOverrides,
} from './template-prompts.js';

describe('classifyPromptFile', () => {
  it('classifies a missing overlay as builtin (fallback)', () => {
    const m = classifyPromptFile('planner.md', 'CORE PLAN', null);
    expect(m).toMatchObject({
      name: 'planner.md',
      role: 'agent',
      source: 'builtin',
      content: 'CORE PLAN',
    });
  });

  it('classifies a plain overlay as pipeline (replace, no tag)', () => {
    const m = classifyPromptFile('planner.md', 'CORE', 'FULL REPLACEMENT');
    expect(m).toMatchObject({
      source: 'pipeline',
      content: 'FULL REPLACEMENT',
    });
  });

  it('strips an explicit <!-- replace --> tag for pipeline content', () => {
    const m = classifyPromptFile(
      'planner.md',
      'CORE',
      '<!-- replace -->\nNEW BODY',
    );
    expect(m.source).toBe('pipeline');
    expect(m.content).toBe('NEW BODY');
  });

  it('classifies an <!-- append --> overlay with override blocks as extends', () => {
    const overlay = [
      '<!-- append -->',
      '## Override: Rules',
      'extra rule',
      '',
      '## Override: Style',
      '<!-- replace -->',
      'new style',
    ].join('\n');
    const m = classifyPromptFile('reviewer.md', 'CORE REVIEW', overlay);
    expect(m.source).toBe('extends');
    expect(m.builtin).toBe('CORE REVIEW');
    expect(m.rawAppend).toBeNull();
    expect(m.contributions).toEqual([
      { section: 'Rules', mode: 'append', body: 'extra rule' },
      { section: 'Style', mode: 'overwrite', body: 'new style' },
    ]);
  });

  it('treats an append overlay with no override blocks as a raw trailing append', () => {
    const m = classifyPromptFile(
      'reviewer.md',
      'CORE',
      '<!-- append -->\n\njust some extra text',
    );
    expect(m.source).toBe('extends');
    expect(m.contributions).toEqual([]);
    expect(m.rawAppend).toBe('just some extra text');
  });

  it('labels role as block for *.block.md files', () => {
    expect(classifyPromptFile('plan.block.md', 'c', null).role).toBe('block');
    expect(classifyPromptFile('planner.md', 'c', null).role).toBe('agent');
  });
});

describe('parseOverrides', () => {
  it('returns [] when there are no override blocks', () => {
    expect(parseOverrides('just text, no headings')).toEqual([]);
  });

  it('detects append vs overwrite per block', () => {
    const body = [
      '',
      '## Override: A',
      'append body',
      '## Override: B',
      '<!-- replace -->',
      'replace body',
    ].join('\n');
    expect(parseOverrides(body)).toEqual([
      { section: 'A', mode: 'append', body: 'append body' },
      { section: 'B', mode: 'overwrite', body: 'replace body' },
    ]);
  });
});

describe('buildPromptsModel', () => {
  let root;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `worca-tpl-prompts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(dir, name, content) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }

  it('unions core + overlay files and classifies each', () => {
    const coreDir = join(root, 'core');
    const overlayDir = join(root, 'overlay');
    write(coreDir, 'planner.md', 'CORE PLAN');
    write(coreDir, 'reviewer.md', 'CORE REVIEW');
    write(coreDir, 'plan.block.md', 'CORE BLOCK');
    // Overlay replaces reviewer, extends plan.block, leaves planner untouched.
    write(overlayDir, 'reviewer.md', 'REPLACED REVIEW');
    write(
      overlayDir,
      'plan.block.md',
      '<!-- append -->\n## Override: Notes\nmore',
    );

    const model = buildPromptsModel(coreDir, overlayDir);
    expect(model['planner.md'].source).toBe('builtin');
    expect(model['reviewer.md'].source).toBe('pipeline');
    expect(model['reviewer.md'].content).toBe('REPLACED REVIEW');
    expect(model['plan.block.md'].source).toBe('extends');
    expect(model['plan.block.md'].contributions).toEqual([
      { section: 'Notes', mode: 'append', body: 'more' },
    ]);
  });

  it('returns core-only when the overlay dir is missing (new draft)', () => {
    const coreDir = join(root, 'core');
    write(coreDir, 'planner.md', 'CORE');
    const model = buildPromptsModel(coreDir, join(root, 'does-not-exist'));
    expect(Object.keys(model)).toEqual(['planner.md']);
    expect(model['planner.md'].source).toBe('builtin');
  });

  it('ignores non-prompt files', () => {
    const coreDir = join(root, 'core');
    write(coreDir, 'planner.md', 'CORE');
    write(coreDir, 'README.txt', 'nope');
    write(coreDir, 'notes.json', '{}');
    const model = buildPromptsModel(coreDir, join(root, 'overlay'));
    expect(Object.keys(model)).toEqual(['planner.md']);
  });
});
