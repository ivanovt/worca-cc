import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  iconSvg,
  Loader,
  Pause,
} from './icons.js';

const CLASS_MAP = {
  pending: 'status-pending',
  running: 'status-running',
  paused: 'status-paused',
  completed: 'status-completed',
  failed: 'status-failed',
  skipped: 'status-skipped',
  cancelled: 'status-cancelled',
  halted: 'status-halted',
  setup_failed: 'status-setup-failed',
  unrecoverable: 'status-unrecoverable',
  // workspace statuses
  planning: 'status-planning',
  integration_testing: 'status-integration-testing',
  integration_failed: 'status-integration-failed',
  blocked: 'status-blocked',
  // legacy aliases
  in_progress: 'status-in-progress',
  error: 'status-error',
  interrupted: 'status-interrupted',
};

const ICON_DATA = {
  pending: Circle,
  running: Loader,
  paused: Pause,
  completed: CircleCheck,
  failed: CircleAlert,
  skipped: CircleSlash,
  cancelled: CircleSlash,
  halted: CircleSlash,
  setup_failed: CircleAlert,
  unrecoverable: CircleAlert,
  // workspace statuses
  planning: Loader,
  integration_testing: Loader,
  integration_failed: CircleAlert,
  blocked: Pause,
  // legacy aliases
  in_progress: Loader,
  error: CircleAlert,
  interrupted: Pause,
};

/**
 * Resolve display status: if run is not active, in_progress becomes interrupted.
 */
export function resolveStatus(status, isActive) {
  if (status === 'in_progress' && isActive === false) return 'interrupted';
  return status;
}

export function statusClass(status) {
  return CLASS_MAP[status] || 'status-unknown';
}

const DOT_CLASS_MAP = {
  running: 'project-status-running',
  error: 'project-status-error',
  paused: 'project-status-paused',
};

export function statusDotClass(status) {
  return DOT_CLASS_MAP[status] || 'project-status-idle';
}

export function statusIcon(status, size = 14) {
  const data = ICON_DATA[status];
  if (!data) return '?';
  const isActive =
    status === 'in_progress' ||
    status === 'running' ||
    status === 'planning' ||
    status === 'integration_testing';
  const className = isActive ? 'icon-spin' : '';
  return iconSvg(data, size, className);
}
