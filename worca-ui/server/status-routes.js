import { join } from 'node:path';
import { Router } from 'express';
import { countRunningPipelinesAcrossProjects } from './process-registry.js';
import { readGlobalSettings } from './settings-reader.js';

export function createStatusRouter({ prefsDir }) {
  const router = Router();

  router.get('/runs-count', (_req, res) => {
    try {
      const totalRunning = countRunningPipelinesAcrossProjects(prefsDir);
      const globalSettingsPath = join(prefsDir, 'settings.json');
      const globalSettings = readGlobalSettings(globalSettingsPath);
      const cap =
        globalSettings.worca?.parallel?.max_concurrent_pipelines ?? 10;
      res.json({ ok: true, totalRunning, cap });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
