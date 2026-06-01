/**
 * Central path computation for every file the build pipeline writes or
 * reads. Names are derived from the chapter and bullet slugs in
 * lib/script.ts so renaming a slug there cascades through every script
 * and consumer.
 *
 * The functions here return paths RELATIVE to the videos/ project root.
 * Remotion's `staticFile()` accepts a URL fragment relative to public/,
 * so for audio playback we strip the leading "public/" — see `audioUrl`.
 */

import { chapters } from "./script";
import type { BulletScene, Chapter } from "./script";

/** Two-digit padded chapter id, e.g. 1 → "01". */
export const padChapter = (n: number): string => String(n).padStart(2, "0");

/** Two-digit padded global bullet id, e.g. 5 → "05". */
export const padBullet = (n: number): string => String(n).padStart(2, "0");

// ─── Chapter-level paths ──────────────────────────────────────────────────

export const chapterFileBase = (c: Chapter): string =>
  `${padChapter(c.number)}-${c.slug}`;

/** Caption file (SRT). */
export const captionSrtPath = (c: Chapter): string =>
  `captions/${chapterFileBase(c)}.srt`;

/** Caption file (WebVTT). */
export const captionVttPath = (c: Chapter): string =>
  `captions/${chapterFileBase(c)}.vtt`;

/** Rendered video (gitignored). */
export const videoOutPath = (c: Chapter): string =>
  `out/${chapterFileBase(c)}.mp4`;

/** Poster still (gitignored). */
export const posterOutPath = (c: Chapter): string =>
  `out/posters/${chapterFileBase(c)}.jpg`;

// ─── Bullet-level paths ───────────────────────────────────────────────────

export const bulletFileBase = (c: Chapter, b: BulletScene): string =>
  `s${padBullet(b.id)}-${b.slug}`;

/** Voiceover audio file (committed). */
export const audioPath = (c: Chapter, b: BulletScene): string =>
  `public/voiceover/${c.slug}/${bulletFileBase(c, b)}.mp3`;

/** Word-alignment JSON next to the MP3 (committed). */
export const timestampsPath = (c: Chapter, b: BulletScene): string =>
  `public/voiceover/${c.slug}/${bulletFileBase(c, b)}.timestamps.json`;

/** Same path but as a URL fragment for Remotion's staticFile(). The
 *  `public/` prefix is dropped because staticFile resolves against
 *  the public/ folder. */
export const audioUrl = (c: Chapter, b: BulletScene): string =>
  `voiceover/${c.slug}/${bulletFileBase(c, b)}.mp3`;

// ─── Lookup keys for the manifest ─────────────────────────────────────────

/** Key under which a bullet's audio appears in audio-manifest.generated.ts.
 *  Includes the slug so the key is stable even if a bullet is renumbered. */
export const manifestKey = (c: Chapter, b: BulletScene): string =>
  `${chapterFileBase(c)}/${bulletFileBase(c, b)}`;

/** Variant that takes raw ids so callers without chapter/bullet objects
 *  can still resolve a key (used by the cue helper and audio lookups
 *  from BulletScene which only know numbers). Returns null when the
 *  ids don't resolve to a known bullet. */
export const manifestKeyForIds = (
  chapter: number,
  sceneId: number,
): string | null => {
  const c = chapters[chapter as 1 | 2 | 3];
  if (!c) return null;
  const b = c.scenes.find((s) => s.id === sceneId);
  if (!b) return null;
  return manifestKey(c, b);
};

/** Iterator helper — yields every (chapter, bullet) pair across all
 *  three videos in narration order. */
export function* eachBullet(): Generator<{ chapter: Chapter; bullet: BulletScene }> {
  for (const num of [1, 2, 3] as const) {
    const chapter = chapters[num];
    for (const bullet of chapter.scenes) {
      yield { chapter, bullet };
    }
  }
}
