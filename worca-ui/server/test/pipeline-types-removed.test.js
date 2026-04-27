/**
 * TDD: verify pipeline-* protocol types and MultiWatcher are removed.
 * These tests are written first and must initially fail.
 */

import { describe, expect, it } from 'vitest';
import { MESSAGE_TYPES } from '../../app/protocol.js';
import { WatcherSet } from '../watcher-set.js';

const REMOVED_TYPES = [
  'list-pipelines',
  'subscribe-pipeline',
  'unsubscribe-pipeline',
  'pipeline-status-changed',
  'pipelines-list',
];

describe('protocol.js — pipeline-* types removed', () => {
  for (const type of REMOVED_TYPES) {
    it(`MESSAGE_TYPES does not contain "${type}"`, () => {
      expect(MESSAGE_TYPES).not.toContain(type);
    });
  }
});

describe('WatcherSet — MultiWatcher removed', () => {
  it('WatcherSet prototype does not expose getMultiWatcher', () => {
    expect(WatcherSet.prototype.getMultiWatcher).toBeUndefined();
  });

  it('WatcherSet prototype does not expose _createMultiWatcher', () => {
    expect(WatcherSet.prototype._createMultiWatcher).toBeUndefined();
  });
});
