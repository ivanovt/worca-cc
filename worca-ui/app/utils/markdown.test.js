// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('converts markdown headings to HTML', () => {
    const result = renderMarkdown('## Hello');
    expect(result).toContain('<h2');
    expect(result).toContain('Hello');
  });

  it('converts bold text', () => {
    const result = renderMarkdown('**bold**');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('converts code fences', () => {
    const result = renderMarkdown('```js\nconst x = 1;\n```');
    expect(result).toContain('<code');
    expect(result).toContain('const x = 1;');
  });

  it('converts bullet lists', () => {
    const result = renderMarkdown('- item one\n- item two');
    expect(result).toContain('<li>item one</li>');
    expect(result).toContain('<li>item two</li>');
  });

  it('returns empty string for falsy input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  it('escapes to <pre> on parse failure', () => {
    const badInput = {
      toString: () => {
        throw new Error('boom');
      },
    };
    const result = renderMarkdown(badInput);
    expect(result).toContain('<pre>');
  });

  it('strips <script> tags (XSS)', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('strips onerror attributes (XSS)', () => {
    const result = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(result).not.toContain('onerror');
  });

  it('strips javascript: URLs (XSS)', () => {
    const result = renderMarkdown('[click](javascript:alert(1))');
    expect(result).not.toContain('javascript:');
  });

  it('preserves safe HTML elements', () => {
    const result = renderMarkdown('A [link](https://example.com) here');
    expect(result).toContain('<a href="https://example.com"');
  });
});

describe('stripMarkdown', () => {
  it('removes heading markers', () => {
    expect(stripMarkdown('## Hello World')).toBe('Hello World');
  });

  it('removes bold/italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  it('removes inline code backticks', () => {
    expect(stripMarkdown('use `foo()` here')).toBe('use foo() here');
  });

  it('removes link syntax, keeps text', () => {
    expect(stripMarkdown('[click here](https://x.com)')).toBe('click here');
  });

  it('removes bullet markers', () => {
    expect(stripMarkdown('- item one\n- item two')).toBe('item one\nitem two');
  });

  it('returns empty string for falsy input', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown(null)).toBe('');
  });
});
