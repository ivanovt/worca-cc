/**
 * Effective prompt model for the Pipelines editor "Prompts" tab.
 *
 * For each stage prompt file (agent `*.md` and user-prompt `*.block.md`) this
 * resolves what the pipeline actually runs, classifying each file as one of:
 *
 *   - 'builtin'  — the template has no overlay; the built-in core prompt is used
 *                  unchanged (a fallback).
 *   - 'pipeline' — the template overlay replaces the built-in prompt entirely
 *                  (default mode, or an explicit `<!-- replace -->`).
 *   - 'extends'  — the overlay is `<!-- append -->`; it merges into the built-in
 *                  via `## Override: <Section>` blocks (each appending, or
 *                  overwriting when the block opens with `<!-- replace -->`), or
 *                  a raw trailing append when there are no override blocks.
 *
 * Mode/override parsing mirrors src/worca/orchestrator/overlay.py so the editor
 * preview matches what the runtime actually assembles.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OVERLAY_NAME_RE = /^[a-z0-9._-]{1,64}\.(md|block\.md)$/;
const APPEND_TAG = '<!-- append -->';
const REPLACE_TAG = '<!-- replace -->';

/**
 * Split an `<!-- append -->` overlay body into `## Override: <Section>` blocks.
 * Mirrors overlay.py:_parse_overrides. A block whose first non-blank line is
 * `<!-- replace -->` overwrites the matching built-in section; otherwise it
 * appends. Returns `[{ section, mode: 'append'|'overwrite', body }]`.
 */
export function parseOverrides(content) {
  const parts = content.split(/^(## Override:\s*.+)$/m);
  const overrides = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const headingLine = parts[i];
    const section = headingLine.replace(/^##\s*Override:\s*/, '').trim();
    const lines = parts[i + 1].split('\n');
    const kept = [];
    let foundReplace = false;
    let replace = false;
    for (const line of lines) {
      if (!foundReplace && line.trim() === REPLACE_TAG) {
        replace = true;
        foundReplace = true;
        continue;
      }
      kept.push(line);
    }
    overrides.push({
      section,
      mode: replace ? 'overwrite' : 'append',
      body: kept.join('\n').trim(),
    });
  }
  return overrides;
}

/**
 * Classify a single file given its built-in (core) and overlay contents.
 * Either may be null. Returns the per-file model the editor renders.
 */
export function classifyPromptFile(name, coreContent, overlayContent) {
  const role = name.endsWith('.block.md') ? 'block' : 'agent';
  const base = { name, role };

  if (overlayContent == null) {
    return { ...base, source: 'builtin', content: coreContent ?? '' };
  }

  const stripped = overlayContent.replace(/^\s+/, '');

  if (stripped.startsWith(APPEND_TAG)) {
    const body = stripped.slice(APPEND_TAG.length);
    const overrides = parseOverrides(body);
    return {
      ...base,
      source: 'extends',
      builtin: coreContent ?? '',
      contributions: overrides,
      rawAppend: overrides.length === 0 ? body.trim() : null,
    };
  }

  const content = stripped.startsWith(REPLACE_TAG)
    ? stripped.slice(REPLACE_TAG.length).trim()
    : overlayContent.trim();
  return { ...base, source: 'pipeline', content };
}

/**
 * Read every prompt file under a directory (filtered to overlay-name shape),
 * returning `{ filename: content }`. Missing dir → empty object.
 */
function readPromptDir(dir) {
  const out = {};
  if (!dir || !existsSync(dir)) return out;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!OVERLAY_NAME_RE.test(f)) continue;
    try {
      out[f] = readFileSync(join(dir, f), 'utf8');
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

/**
 * Build the prompts model for a template.
 *
 * @param {string} coreDir     - built-in core prompts dir (.../agents/core)
 * @param {string} overlayDir  - template overlay dir (.../<template>/agents); may not exist
 * @returns {object} `{ filename: model }` over the union of core+overlay files
 */
export function buildPromptsModel(coreDir, overlayDir) {
  const core = readPromptDir(coreDir);
  const overlay = readPromptDir(overlayDir);
  const names = new Set([...Object.keys(core), ...Object.keys(overlay)]);
  const model = {};
  for (const name of names) {
    model[name] = classifyPromptFile(
      name,
      Object.hasOwn(core, name) ? core[name] : null,
      Object.hasOwn(overlay, name) ? overlay[name] : null,
    );
  }
  return model;
}
