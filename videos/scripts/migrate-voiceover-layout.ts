/**
 * One-shot migration: move voiceover MP3s + timestamp JSONs from the
 * old flat naming (public/voiceover/v{N}-s{NN}.*) to the new
 * content-named layout (public/voiceover/<chapter-slug>/s{NN}-<slug>.*),
 * and patch each timestamps.json with the `sourceText` field that the
 * staleness check needs.
 *
 * After this runs, `npm run voiceover` sees fresh audio that matches the
 * current script and won't burn any ElevenLabs credits.
 *
 * Safe to re-run: idempotent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { audioPath, eachBullet, timestampsPath } from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const oldMp3 = (chapter: number, sceneId: number): string =>
  path.join(
    projectRoot,
    "public",
    "voiceover",
    `v${chapter}-s${String(sceneId).padStart(2, "0")}.mp3`,
  );

const oldTs = (chapter: number, sceneId: number): string =>
  path.join(
    projectRoot,
    "public",
    "voiceover",
    `v${chapter}-s${String(sceneId).padStart(2, "0")}.timestamps.json`,
  );

const main = async (): Promise<void> => {
  let moved = 0;
  let skipped = 0;

  for (const { chapter, bullet } of eachBullet()) {
    const newMp3 = path.join(projectRoot, audioPath(chapter, bullet));
    const newTs = path.join(projectRoot, timestampsPath(chapter, bullet));
    const oldM = oldMp3(chapter.number, bullet.id);
    const oldT = oldTs(chapter.number, bullet.id);

    // Skip if already migrated.
    try {
      await fs.access(newMp3);
      await fs.access(newTs);
      skipped++;
      continue;
    } catch {
      // Not yet migrated — proceed.
    }

    // Ensure chapter directory exists.
    await fs.mkdir(path.dirname(newMp3), { recursive: true });

    // Move MP3.
    try {
      await fs.rename(oldM, newMp3);
    } catch (err) {
      console.error(
        `FAIL move ${path.relative(projectRoot, oldM)}: ${(err as Error).message}`,
      );
      process.exit(1);
    }

    // Read old timestamps, patch in sourceText, write to new location,
    // delete old.
    let patched = {};
    try {
      const raw = await fs.readFile(oldT, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        // Very old format — array of words only.
        const lastEnd = data.length ? data[data.length - 1].endSeconds ?? 0 : 0;
        patched = {
          sourceText: bullet.body,
          durationSeconds: lastEnd,
          words: data,
        };
      } else {
        patched = {
          sourceText: bullet.body,
          durationSeconds: data.durationSeconds ?? 0,
          words: data.words ?? [],
        };
      }
    } catch (err) {
      console.error(
        `FAIL read ${path.relative(projectRoot, oldT)}: ${(err as Error).message}`,
      );
      process.exit(1);
    }
    await fs.writeFile(newTs, JSON.stringify(patched, null, 2));
    try {
      await fs.unlink(oldT);
    } catch {
      // Already gone — fine.
    }

    moved++;
    console.log(
      `moved  v${chapter.number}-s${String(bullet.id).padStart(2, "0")} → ${chapter.slug}/s${String(bullet.id).padStart(2, "0")}-${bullet.slug}`,
    );
  }

  console.log(`\ndone · moved=${moved} · skipped=${skipped}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
