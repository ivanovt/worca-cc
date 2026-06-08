import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { GitPullRequest, iconSvg } from '../utils/icons.js';
import { scrollOnExpand } from '../utils/scroll.js';

function _fileLineAnchor(comment) {
  if (!comment.path) return nothing;
  const line = comment.line ? `:${comment.line}` : '';
  return html`<span class="pr-comment-anchor">${comment.path}${line}</span>`;
}

function _addressedRowView(comment) {
  if (
    !comment.addressed_by_bead &&
    !comment.addressed_by_commit &&
    !comment.thread_reply
  ) {
    return nothing;
  }
  return html`
    <div class="pr-comment-addressed">
      ${
        comment.addressed_by_bead || comment.addressed_by_commit
          ? html`<span class="pr-comment-addressed-label">Addressed:</span>
          ${comment.addressed_by_bead ? html`<span class="pr-comment-bead">${comment.addressed_by_bead}</span>` : nothing}
          ${comment.addressed_by_commit ? html`<code class="pr-comment-commit">${comment.addressed_by_commit.slice(0, 7)}</code>` : nothing}`
          : nothing
      }
      ${
        comment.thread_reply
          ? html`<span class="pr-comment-reply">${comment.thread_reply}</span>`
          : nothing
      }
    </div>
  `;
}

function _commentRowView(comment) {
  return html`
    <div class="pr-comment-row">
      <div class="pr-comment-meta">
        ${_fileLineAnchor(comment)}
        <span class="pr-comment-author">@${comment.author}</span>
      </div>
      <div class="pr-comment-body">${comment.body}</div>
      ${_addressedRowView(comment)}
    </div>
  `;
}

/**
 * Render the PR review comments panel from status.review_feedback.
 * @param {Array|null|undefined} reviewFeedback - The review_feedback list from status.json
 */
export function prCommentsView(reviewFeedback) {
  if (!reviewFeedback || reviewFeedback.length === 0) return nothing;

  return html`
    <div class="pr-comments-section">
      <sl-details class="pr-comments-panel" @sl-after-show=${scrollOnExpand}>
        <div slot="summary" class="pr-comments-header">
          <span class="pr-comments-icon">${unsafeHTML(iconSvg(GitPullRequest, 16))}</span>
          <span class="pr-comments-title">Review Comments</span>
          <sl-badge variant="warning" pill>${reviewFeedback.length}</sl-badge>
        </div>
        <div class="pr-comments-list">
          ${reviewFeedback.map(_commentRowView)}
        </div>
      </sl-details>
    </div>
  `;
}
