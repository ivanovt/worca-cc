/**
 * Cue helpers — translate spoken words into frame offsets so diagram
 * element reveals can land on the narration instead of on fixed strides.
 *
 * Usage from a diagram component:
 *
 *   import { cueFrame } from "../lib/cue";
 *   const startFrame = cueFrame(chapterNumber, sceneId, "prompt", {
 *     fallback: 30,           // when there's no audio yet, or the word
 *                              //   isn't present in the alignment
 *     occurrence: 0,          // 0 = first match, 1 = second, …
 *     offsetFrames: -6,       // negative = land slightly BEFORE the word
 *   });
 *   const reveal = useReveal({ startFrame });
 *
 * Frames returned are scene-local (relative to scene start), already
 * compensated for the LEAD_IN_FRAMES delay between scene start and the
 * first word of audio.
 */

import { theme } from "../theme";
import { wordsForScene } from "./audio-manifest.generated";
import { LEAD_IN_FRAMES } from "./timing";

export interface CueOptions {
  /** Returned when no audio exists OR the word isn't in the alignment. */
  fallback: number;
  /** 0 = first match, 1 = second occurrence, etc. Default 0. */
  occurrence?: number;
  /** Added to the computed frame; useful for landing reveals slightly
   *  before or after the word is spoken. Default 0. */
  offsetFrames?: number;
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    // strip leading/trailing punctuation so "prompt." matches "prompt"
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");

/** Find the frame on which a specific spoken word starts.
 *
 *  Returns `fallback` (in frames) if there's no audio for the scene yet
 *  or the word/occurrence isn't found. */
export const cueFrame = (
  chapter: number,
  sceneId: number,
  cueWord: string,
  options: CueOptions,
): number => {
  const words = wordsForScene(chapter, sceneId);
  const occurrence = options.occurrence ?? 0;
  const offset = options.offsetFrames ?? 0;

  if (!words || words.length === 0) {
    return options.fallback;
  }

  const target = normalize(cueWord);
  let seen = 0;

  for (const [w, startSec] of words) {
    if (normalize(w) === target) {
      if (seen === occurrence) {
        // Audio plays AFTER LEAD_IN_FRAMES of the scene's start.
        return LEAD_IN_FRAMES + Math.round(startSec * theme.fps) + offset;
      }
      seen++;
    }
  }
  return options.fallback;
};

/** Convenience: cue offset measured against the START of the audio (not
 *  the start of the scene), so callers using a fixed lead-in can compute
 *  reveals without thinking about LEAD_IN_FRAMES themselves. */
export const cueFrameFromAudioStart = (
  chapter: number,
  sceneId: number,
  cueWord: string,
  options: CueOptions,
): number => cueFrame(chapter, sceneId, cueWord, options) - LEAD_IN_FRAMES;
