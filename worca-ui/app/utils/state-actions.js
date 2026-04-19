export const STATES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];

const ACTION_MATRIX = {
  stop: { running: true },
  pause: { running: true },
  resume: { paused: true, failed: true, interrupted: true },
  cancel: {
    pending: true,
    running: true,
    paused: true,
    failed: true,
    interrupted: true,
  },
  archive: {
    pending: true,
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
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
  },
  learn: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
};

export function actionAllowed(action, status) {
  return Boolean(ACTION_MATRIX[action]?.[status]);
}
