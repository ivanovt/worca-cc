/**
 * Format browser tab title with optional project name.
 * @param {string} [projectName]
 * @returns {string}
 */
export function formatTitle(projectName) {
  return projectName ? `${projectName} — worca` : 'worca';
}
