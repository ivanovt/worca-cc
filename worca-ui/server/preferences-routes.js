import { join } from 'node:path';
import { Router } from 'express';
import { readGlobalSettings, writeGlobalSettings } from './settings-reader.js';

const VALID_CLEANUP_POLICIES = ['never', 'on-success', 'manual-only'];
const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
const MIN_DISK_BYTES = 500_000_000;
const MAX_DISK_BYTES = 50_000_000_000;

export function validateGlobalSettingsPayload(body) {
  const details = [];

  if (body.worca !== undefined) {
    if (
      typeof body.worca !== 'object' ||
      body.worca === null ||
      Array.isArray(body.worca)
    ) {
      details.push('worca must be an object');
      return { valid: false, details };
    }
    const w = body.worca;

    if (w.parallel !== undefined) {
      if (
        typeof w.parallel !== 'object' ||
        w.parallel === null ||
        Array.isArray(w.parallel)
      ) {
        details.push('worca.parallel must be an object');
      } else {
        if (w.parallel.max_concurrent_pipelines !== undefined) {
          const v = w.parallel.max_concurrent_pipelines;
          if (!Number.isInteger(v) || v < 1 || v > 100) {
            details.push(
              'max_concurrent_pipelines must be an integer between 1 and 100',
            );
          }
        }
        if (w.parallel.cleanup_policy !== undefined) {
          if (!VALID_CLEANUP_POLICIES.includes(w.parallel.cleanup_policy)) {
            details.push(
              `cleanup_policy must be one of: ${VALID_CLEANUP_POLICIES.join(', ')}`,
            );
          }
        }
      }
    }

    if (w.ui !== undefined) {
      if (typeof w.ui !== 'object' || w.ui === null || Array.isArray(w.ui)) {
        details.push('worca.ui must be an object');
      } else if (w.ui.worktree_disk_warning_bytes !== undefined) {
        const v = w.ui.worktree_disk_warning_bytes;
        if (
          typeof v !== 'number' ||
          !Number.isFinite(v) ||
          v < MIN_DISK_BYTES ||
          v > MAX_DISK_BYTES
        ) {
          details.push(
            `worktree_disk_warning_bytes must be a number between ${MIN_DISK_BYTES} and ${MAX_DISK_BYTES}`,
          );
        }
      }
    }

    if (w.circuit_breaker !== undefined) {
      if (
        typeof w.circuit_breaker !== 'object' ||
        w.circuit_breaker === null ||
        Array.isArray(w.circuit_breaker)
      ) {
        details.push('worca.circuit_breaker must be an object');
      } else if (w.circuit_breaker.classifier_model !== undefined) {
        if (!VALID_MODELS.includes(w.circuit_breaker.classifier_model)) {
          details.push(
            `classifier_model must be one of: ${VALID_MODELS.join(', ')}`,
          );
        }
      }
    }
  }

  return details.length ? { valid: false, details } : { valid: true };
}

export function createPreferencesRouter({ prefsDir }) {
  const router = Router();
  const globalSettingsPath = join(prefsDir, 'settings.json');

  router.get('/', (_req, res) => {
    try {
      const prefs = readGlobalSettings(globalSettingsPath);
      res.json({ ok: true, preferences: prefs });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'Failed to read global preferences',
        detail: err.message,
      });
    }
  });

  router.put('/', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Request body must be a JSON object',
          details: [],
        },
      });
    }

    const validation = validateGlobalSettingsPayload(body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Invalid preferences payload',
          details: validation.details,
        },
      });
    }

    try {
      const merged = writeGlobalSettings(globalSettingsPath, body);
      res.json({ ok: true, preferences: merged });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'Failed to write global preferences',
        detail: err.message,
      });
    }
  });

  return router;
}
