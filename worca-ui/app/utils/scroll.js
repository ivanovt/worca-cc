/**
 * Scroll-on-expand handler for sl-details panels.
 * Use as: @sl-after-show=${scrollOnExpand}
 *
 * After the expand animation completes, checks if the panel's content
 * extends below the visible area. If so, scrolls the panel header to
 * the top of its scroll container.
 */
export function scrollOnExpand(e) {
  const panel = e.target;
  if (!panel) return;

  // Find the scroll container (closest ancestor with overflow auto/scroll)
  const container =
    panel.closest('.main-content') || panel.closest('.run-detail-layout__logs');
  if (!container) {
    // Fallback: use scrollIntoView on the element itself
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const panelRect = panel.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // If the bottom of the panel is below the container's visible area, scroll
  if (panelRect.bottom > containerRect.bottom) {
    // Scroll so the panel header sits near the top of the container
    const scrollTop =
      container.scrollTop + (panelRect.top - containerRect.top) - 12;
    container.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }
}
