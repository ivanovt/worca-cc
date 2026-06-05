/**
 * Tests: run-detail-pr-comments.js — PR review comments panel.
 * TDD: written to drive implementation.
 */

import { describe, expect, it } from 'vitest';
import { prCommentsView } from './run-detail-pr-comments.js';

const LIT_NOTHING = Symbol.for('lit-nothing');

function renderToString(template) {
  if (template === null || template === undefined) return '';
  if (typeof template === 'symbol') return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'symbol') {
        // lit-html nothing — omit
      } else if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const inlineComment = {
  thread_id: 'PRRT_abc',
  path: 'src/foo.py',
  line: 42,
  author: 'reviewer-alice',
  body: 'this leaks a file handle',
  kind: 'inline',
  created_at: '2026-06-03T12:00:00Z',
};

const prLevelComment = {
  thread_id: 'PRRT_xyz',
  path: null,
  line: null,
  author: 'reviewer-bob',
  body: 'add a test for the empty case',
  kind: 'pr_level',
  created_at: '2026-06-03T13:00:00Z',
};

const addressedComment = {
  ...inlineComment,
  thread_id: 'PRRT_def',
  body: 'rename for clarity',
  addressed_by_bead: 'worca-cc-master-xyz1',
  addressed_by_commit: 'abc1234',
  thread_reply: 'Addressed in commit abc1234 (bead worca-cc-master-xyz1)',
};

describe('prCommentsView — empty / null', () => {
  it('returns nothing when review_feedback is null', () => {
    const out = renderToString(prCommentsView(null));
    expect(out).toBe('');
  });

  it('returns nothing when review_feedback is undefined', () => {
    const out = renderToString(prCommentsView(undefined));
    expect(out).toBe('');
  });

  it('returns nothing when review_feedback is empty array', () => {
    const out = renderToString(prCommentsView([]));
    expect(out).toBe('');
  });
});

describe('prCommentsView — renders comments from review_feedback', () => {
  it('renders the pr-comments panel container', () => {
    const out = renderToString(prCommentsView([inlineComment]));
    expect(out).toContain('pr-comments');
  });

  it('renders comment count in summary', () => {
    const out = renderToString(prCommentsView([inlineComment, prLevelComment]));
    expect(out).toContain('2');
  });

  it('renders author for each comment', () => {
    const out = renderToString(prCommentsView([inlineComment]));
    expect(out).toContain('reviewer-alice');
  });

  it('renders comment body', () => {
    const out = renderToString(prCommentsView([inlineComment]));
    expect(out).toContain('this leaks a file handle');
  });

  it('renders file:line anchor for inline comments', () => {
    const out = renderToString(prCommentsView([inlineComment]));
    expect(out).toContain('src/foo.py');
    expect(out).toContain('42');
  });

  it('renders both comments when multiple provided', () => {
    const out = renderToString(prCommentsView([inlineComment, prLevelComment]));
    expect(out).toContain('reviewer-alice');
    expect(out).toContain('reviewer-bob');
    expect(out).toContain('this leaks a file handle');
    expect(out).toContain('add a test for the empty case');
  });
});

describe('prCommentsView — pr_level comments', () => {
  it('renders pr_level comment without file:line', () => {
    const out = renderToString(prCommentsView([prLevelComment]));
    expect(out).toContain('reviewer-bob');
    expect(out).toContain('add a test for the empty case');
  });

  it('does not show null path for pr_level comment', () => {
    const out = renderToString(prCommentsView([prLevelComment]));
    expect(out).not.toContain('null');
  });
});

describe('prCommentsView — addressed comments', () => {
  it('shows addressed_by_bead when present', () => {
    const out = renderToString(prCommentsView([addressedComment]));
    expect(out).toContain('worca-cc-master-xyz1');
  });

  it('shows addressed_by_commit when present', () => {
    const out = renderToString(prCommentsView([addressedComment]));
    expect(out).toContain('abc1234');
  });

  it('shows thread_reply when present', () => {
    const out = renderToString(prCommentsView([addressedComment]));
    expect(out).toContain('Addressed in commit abc1234');
  });

  it('does not show addressed fields for unaddressed comment', () => {
    const out = renderToString(prCommentsView([inlineComment]));
    expect(out).not.toContain('addressed_by');
    expect(out).not.toContain('thread_reply');
  });
});
