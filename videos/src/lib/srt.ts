/**
 * SRT generator.
 *
 * Produces one SubRip subtitle file per video (Video 1 / 2 / 3). Cues are
 * one-sentence-per-cue, with timings derived from word counts using the
 * same constants as lib/timing.ts so on-screen scene durations and
 * subtitle timings always agree.
 *
 * Output is *not* rendered onto the video — the user wants a clean visual
 * (diagrams only) with subtitles delivered as a separate file the viewer
 * can toggle in their player.
 */

import { chapters } from "./script";
import type { BulletScene, Chapter } from "./script";
import { audioDuration } from "./audio-manifest.generated";

const WORDS_PER_SECOND = 2.5;
const LEAD_IN_SECONDS = 0.8;
const LEAD_OUT_SECONDS = 1.0;
const CHAPTER_CARD_SECONDS = 3.0;

interface Cue {
  index: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

const pad = (n: number, width: number): string =>
  String(n).padStart(width, "0");

const formatSrtTime = (seconds: number): string => {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  // Guard the millisecond rollover (e.g. .9996 → 1000)
  const carry = ms === 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s + (carry ? 1 : 0), 2)},${pad(
    carry ? 0 : ms,
    3,
  )}`;
};

const countWords = (s: string): number =>
  s.trim().split(/\s+/).filter(Boolean).length;

const splitSentences = (body: string): string[] =>
  body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const buildCuesForBullet = (
  scene: BulletScene,
  chapterNumber: number,
  bulletStartSeconds: number,
): { cues: Omit<Cue, "index">[]; bulletDurationSeconds: number } => {
  const sentences = splitSentences(scene.body);
  // Prefer the real audio duration when a voiceover has been generated;
  // fall back to the 150 wpm estimate otherwise.
  const actualAudio = audioDuration(chapterNumber, scene.id);
  const narrationSeconds = actualAudio ?? scene.words / WORDS_PER_SECOND;
  const bulletDurationSeconds =
    LEAD_IN_SECONDS + narrationSeconds + LEAD_OUT_SECONDS;

  const totalWordsInSentences = sentences.reduce(
    (acc, s) => acc + countWords(s),
    0,
  );

  const cues: Omit<Cue, "index">[] = [];
  let cursor = bulletStartSeconds + LEAD_IN_SECONDS;
  for (const sentence of sentences) {
    const wordsInSentence = countWords(sentence);
    const dur =
      (wordsInSentence / Math.max(totalWordsInSentences, 1)) * narrationSeconds;
    const start = cursor;
    const end = start + dur;
    cues.push({ startSeconds: start, endSeconds: end, text: sentence });
    cursor = end;
  }

  return { cues, bulletDurationSeconds };
};

export const buildSrtForChapter = (chapter: Chapter): string => {
  let cumulative = CHAPTER_CARD_SECONDS; // chapter intro card (silent)
  const allCues: Cue[] = [];
  let nextIndex = 1;

  for (const scene of chapter.scenes) {
    const { cues, bulletDurationSeconds } = buildCuesForBullet(
      scene,
      chapter.number,
      cumulative,
    );
    for (const cue of cues) {
      allCues.push({ ...cue, index: nextIndex++ });
    }
    cumulative += bulletDurationSeconds;
  }
  // chapter outro card (silent) — no cue, just advances total runtime
  cumulative += CHAPTER_CARD_SECONDS;

  return allCues
    .map(
      (c) =>
        `${c.index}\n${formatSrtTime(c.startSeconds)} --> ${formatSrtTime(
          c.endSeconds,
        )}\n${c.text}\n`,
    )
    .join("\n");
};

export const buildAllSrt = (): Record<1 | 2 | 3, string> => ({
  1: buildSrtForChapter(chapters[1]),
  2: buildSrtForChapter(chapters[2]),
  3: buildSrtForChapter(chapters[3]),
});
