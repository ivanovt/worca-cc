/**
 * Archive/Unarchive run actions — extracted for testability.
 *
 * @param {object} deps - Injected dependencies
 * @param {function} deps.showConfirm - Confirmation dialog
 * @param {function} deps.showActionError - Error display
 * @param {function} deps.runUrl - URL builder for run-scoped endpoints,
 *   called as `runUrl(runId, path)`. Must resolve the run's owning project so
 *   archive/unarchive work in global mode (where no project is selected and
 *   the legacy `/api/...` mount has no `worcaDir`).
 * @param {object} deps.store - State store (getState, setRun)
 * @param {function} deps.rerender - Re-render UI
 * @param {function} deps.fetchFn - fetch implementation (defaults to global fetch)
 */
export function createArchiveActions({
  showConfirm,
  showActionError,
  runUrl,
  store,
  rerender,
  fetchFn = fetch,
}) {
  function archiveRun(runId) {
    showConfirm(
      {
        label: 'Archive Pipeline Run',
        message:
          "This run will be hidden from the dashboard and history. You can find it later using the 'archived' filter.",
        confirmLabel: 'Archive',
        confirmVariant: 'danger',
        onConfirm: async () => {
          try {
            const res = await fetchFn(runUrl(runId, `/runs/${runId}/archive`), {
              method: 'POST',
            });
            const data = await res.json();
            if (!data.ok) {
              showActionError(data.error || 'Failed to archive run');
              return;
            }
            const existing = store.getRunById(runId);
            if (existing) {
              store.setRun(runId, {
                ...existing,
                archived: true,
                archived_at: new Date().toISOString(),
              });
            }
          } catch (err) {
            showActionError(err?.message || 'Failed to archive run');
          }
        },
      },
      rerender,
    );
  }

  async function unarchiveRun(runId) {
    try {
      const res = await fetchFn(runUrl(runId, `/runs/${runId}/unarchive`), {
        method: 'POST',
      });
      const data = await res.json();
      if (!data.ok) {
        showActionError(data.error || 'Failed to unarchive run');
        return;
      }
      const existing = store.getRunById(runId);
      if (existing) {
        const { archived: _a, archived_at: _b, ...rest } = existing;
        store.setRun(runId, rest);
      }
    } catch (err) {
      showActionError(err?.message || 'Failed to unarchive run');
    }
  }

  return { archiveRun, unarchiveRun };
}
