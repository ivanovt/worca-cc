import createDOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

const DOMPurify =
  typeof createDOMPurify === 'function' && !createDOMPurify.sanitize
    ? createDOMPurify(globalThis.window || globalThis)
    : createDOMPurify;

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    return DOMPurify.sanitize(marked.parse(String(text)));
  } catch {
    let raw;
    try {
      raw = String(text);
    } catch {
      raw = '[unrenderable]';
    }
    const esc = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre>${esc}</pre>`;
  }
}

export function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '');
}
