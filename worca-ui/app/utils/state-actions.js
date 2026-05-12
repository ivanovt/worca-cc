export const STATES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'halted',
  'setup_failed',
  'unrecoverable',
];

const ACTION_MATRIX = {
  stop: { running: true },
  pause: { running: true },
  resume: { paused: true, failed: true, interrupted: true, halted: true },
  cancel: {
    pending: true,
    running: true,
    paused: true,
    failed: true,
    interrupted: true,
    halted: true,
    setup_failed: true,
  },
  archive: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
    setup_failed: true,
    unrecoverable: true,
  },
  unarchive: {
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
  delete: {
    pending: true,
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
    setup_failed: true,
    unrecoverable: true,
  },
  learn: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
  },
};

export function actionAllowed(action, status) {
  return Boolean(ACTION_MATRIX[action]?.[status]);
}
