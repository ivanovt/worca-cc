/**
 * Map word counts to scene durations.
 *
 * Single source of timing truth so each scene's length flows from its
 * narration length (script.ts → BulletScene.words). When you tighten or
 * expand a script paragraph, scene length updates automatically without
 * hand-counting frames.
 */

import { theme } from "../theme";

/** 150 wpm = 2.5 wps; the same baseline used in docs/how-it-works.md. */
const WORDS_PER_SECOND = 2.5;

/** Breath before the first word — title card lands and settles. */
const LEAD_IN_SECONDS = 0.8;

/** Breath after the last word — viewer reads the final line, scene exits. */
const LEAD_OUT_SECONDS = 1.0;

/** Title-card-only segments (chapter intro / outro) get this fixed duration. */
export const CHAPTER_CARD_SECONDS = 3.0;

export const sceneFramesForWords = (words: number): number => {
  const narration = words / WORDS_PER_SECOND;
  return Math.ceil((LEAD_IN_SECONDS + narration + LEAD_OUT_SECONDS) * theme.fps);
};

export const chapterCardFrames = (): number =>
  Math.ceil(CHAPTER_CARD_SECONDS * theme.fps);

/** Lead-in offset in frames (used by scene components to delay their body
 *  reveal relative to the scene's own start). */
export const LEAD_IN_FRAMES = Math.round(LEAD_IN_SECONDS * theme.fps);
