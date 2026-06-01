/**
 * CLI: generate ElevenLabs voiceover MP3s + per-word timestamps for every
 * bullet in the script.
 *
 * Reads bullet data from src/lib/script.ts, calls the ElevenLabs
 * `text-to-speech/{voice_id}/with-timestamps` endpoint per bullet, writes
 * the audio + alignment under public/voiceover/<chapter-slug>/.
 *
 * Run with:
 *
 *   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… npm run voiceover
 *
 * Behaviour:
 *   - Skip-if-exists: a bullet whose MP3 already exists is not
 *     re-generated …
 *   - …UNLESS the saved sourceText differs from the current bullet's
 *     `body` in script.ts. That catches the case where the narration
 *     was edited but the audio wasn't manually deleted.
 *   - `--force` bypasses both checks and re-generates everything.
 *   - `--chapter=N` limits the run to a single chapter (still rebuilds
 *     the manifest with cached entries from the others).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BulletScene, Chapter } from "../src/lib/script";
import {
  audioPath,
  bulletFileBase,
  chapterFileBase,
  eachBullet,
  manifestKey,
  timestampsPath,
} from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const FORCE = process.argv.includes("--force");
const CHAPTER_ARG = process.argv.find((a) => a.startsWith("--chapter="));
const CHAPTER_FILTER = CHAPTER_ARG ? Number(CHAPTER_ARG.split("=")[1]) : null;

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";

if (!API_KEY || !VOICE_ID) {
  console.error(
    "ERROR: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are both required.\n" +
      "Pass inline:\n" +
      "  ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… npm run voiceover\n",
  );
  process.exit(1);
}

// Voice settings tuned for a product-explainer read: warm + confident,
// not over-emoted.
const VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.8,
  style: 0.15,
  use_speaker_boost: true,
};

interface AlignmentResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
}

interface WordTimestamp {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

interface SceneTimings {
  /** The exact bullet `body` that produced this audio. Used for
   *  staleness detection — if the current script text differs we regen. */
  sourceText: string;
  durationSeconds: number;
  words: WordTimestamp[];
}

const isWordChar = (c: string): boolean => /[A-Za-z0-9'’\-]/.test(c);

const buildWordTimestamps = (
  alignment: AlignmentResponse["alignment"],
): WordTimestamp[] => {
  if (!alignment) return [];
  const { characters, character_start_times_seconds, character_end_times_seconds } =
    alignment;
  const words: WordTimestamp[] = [];
  let current = "";
  let wordStart = 0;
  let wordEndIdx = -1;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (isWordChar(ch)) {
      if (!current) wordStart = character_start_times_seconds[i];
      current += ch;
      wordEndIdx = i;
    } else if (current) {
      words.push({
        word: current,
        startSeconds: wordStart,
        endSeconds: character_end_times_seconds[wordEndIdx],
      });
      current = "";
      wordEndIdx = -1;
    }
  }
  if (current && wordEndIdx >= 0) {
    words.push({
      word: current,
      startSeconds: wordStart,
      endSeconds: character_end_times_seconds[wordEndIdx],
    });
  }
  return words;
};

const readTimingsFromDisk = async (
  c: Chapter,
  b: BulletScene,
): Promise<SceneTimings | null> => {
  try {
    const buf = await fs.readFile(path.join(projectRoot, timestampsPath(c, b)), "utf8");
    const data = JSON.parse(buf);
    if (Array.isArray(data)) {
      // Legacy format (no sourceText) — treat as stale so it regenerates.
      return null;
    }
    if (
      typeof data.durationSeconds !== "number" ||
      typeof data.sourceText !== "string" ||
      !Array.isArray(data.words)
    ) {
      return null;
    }
    return data as SceneTimings;
  } catch {
    return null;
  }
};

const generateForScene = async (
  c: Chapter,
  b: BulletScene,
): Promise<{
  status: "skipped-fresh" | "regenerated" | "first-time";
  bytes?: number;
  durationSeconds?: number;
  words?: WordTimestamp[];
}> => {
  const mp3Abs = path.join(projectRoot, audioPath(c, b));
  const tsAbs = path.join(projectRoot, timestampsPath(c, b));

  // Decide whether to regenerate.
  let regenReason: string | null = null;
  if (FORCE) {
    regenReason = "force";
  } else {
    const onDisk = await readTimingsFromDisk(c, b);
    if (!onDisk) {
      regenReason = "missing";
    } else if (onDisk.sourceText !== b.body) {
      regenReason = "text-changed";
    }
    if (!regenReason) {
      // Audio is fresh — but verify the MP3 itself is there.
      try {
        await fs.access(mp3Abs);
        return { status: "skipped-fresh" };
      } catch {
        regenReason = "mp3-missing";
      }
    }
  }

  // Call the API.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`;
  const body = {
    text: b.body,
    model_id: MODEL_ID,
    voice_settings: VOICE_SETTINGS,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `${bulletFileBase(c, b)}: ElevenLabs API ${res.status}\n${errBody.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as AlignmentResponse;
  if (!data.audio_base64) {
    throw new Error(`${bulletFileBase(c, b)}: missing audio_base64 in response`);
  }
  const audioBuf = Buffer.from(data.audio_base64, "base64");

  // Ensure chapter directory exists.
  await fs.mkdir(path.dirname(mp3Abs), { recursive: true });
  await fs.writeFile(mp3Abs, audioBuf);

  const words = buildWordTimestamps(data.alignment);
  const lastEnd = data.alignment?.character_end_times_seconds?.slice(-1)[0] ?? 0;
  const durationSeconds =
    lastEnd || (words.length ? words[words.length - 1].endSeconds : 0);

  const timings: SceneTimings = {
    sourceText: b.body,
    durationSeconds,
    words,
  };
  await fs.writeFile(tsAbs, JSON.stringify(timings, null, 2));

  return {
    status: regenReason === "missing" || regenReason === "mp3-missing" ? "first-time" : "regenerated",
    bytes: audioBuf.length,
    durationSeconds,
    words,
  };
};

const writeManifest = async (
  scenes: Map<string, { duration: number; words: WordTimestamp[]; sourceText: string }>,
): Promise<void> => {
  const manifestPath = path.join(
    projectRoot,
    "src",
    "lib",
    "audio-manifest.generated.ts",
  );
  const entries = [...scenes.entries()].sort(([a], [b]) => a.localeCompare(b));

  const durationsBody = entries
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${v.duration.toFixed(3)},`)
    .join("\n");

  const wordsBody = entries
    .map(([k, v]) => {
      const inner = v.words
        .map(
          (w) =>
            `    [${JSON.stringify(w.word)}, ${w.startSeconds.toFixed(3)}, ${w.endSeconds.toFixed(3)}]`,
        )
        .join(",\n");
      return `  ${JSON.stringify(k)}: [\n${inner}\n  ],`;
    })
    .join("\n");

  const content = `/**
 * AUTO-GENERATED by scripts/generate-voiceover.ts — do not edit by hand.
 *
 * Keys are \`<chapter-id>-<chapter-slug>/<bullet-file-base>\`, computed by
 * lib/paths.ts manifestKey(). Lookups by (chapter, sceneId) use
 * manifestKeyForIds() so callers don't need to know the format.
 */

import { manifestKeyForIds } from "./paths";

export const audioDurations: Record<string, number> = {
${durationsBody}
};

export type WordTuple = [word: string, startSeconds: number, endSeconds: number];

export const wordTimestamps: Record<string, WordTuple[]> = {
${wordsBody}
};

export const hasAudio = (chapter: number, sceneId: number): boolean => {
  const k = manifestKeyForIds(chapter, sceneId);
  return k !== null && k in audioDurations;
};

export const audioDuration = (
  chapter: number,
  sceneId: number,
): number | undefined => {
  const k = manifestKeyForIds(chapter, sceneId);
  return k === null ? undefined : audioDurations[k];
};

export const wordsForScene = (
  chapter: number,
  sceneId: number,
): WordTuple[] | undefined => {
  const k = manifestKeyForIds(chapter, sceneId);
  return k === null ? undefined : wordTimestamps[k];
};
`;
  await fs.writeFile(manifestPath, content);
  console.log(
    `wrote ${path.relative(projectRoot, manifestPath)} — ${entries.length} entries`,
  );
};

const main = async (): Promise<void> => {
  console.log(
    `voice ${VOICE_ID} · model ${MODEL_ID} · force=${FORCE}` +
      (CHAPTER_FILTER !== null ? ` · chapter=${CHAPTER_FILTER}` : "") +
      "\n",
  );

  let generated = 0;
  let skipped = 0;
  let textChangedRegens = 0;
  let totalBytes = 0;
  const sceneEntries = new Map<
    string,
    { duration: number; words: WordTimestamp[]; sourceText: string }
  >();

  for (const { chapter, bullet } of eachBullet()) {
    if (CHAPTER_FILTER !== null && chapter.number !== CHAPTER_FILTER) {
      // Still seed the manifest from disk so partial runs produce a
      // complete manifest.
      const onDisk = await readTimingsFromDisk(chapter, bullet);
      if (onDisk) {
        sceneEntries.set(manifestKey(chapter, bullet), {
          duration: onDisk.durationSeconds,
          words: onDisk.words,
          sourceText: onDisk.sourceText,
        });
      }
      continue;
    }

    const key = manifestKey(chapter, bullet);
    const label = `${chapterFileBase(chapter)}/${bulletFileBase(chapter, bullet)}`;
    const start = Date.now();

    let r;
    try {
      r = await generateForScene(chapter, bullet);
    } catch (err) {
      console.error(`  FAIL   ${label}:`, (err as Error).message);
      process.exit(1);
    }

    if (r.status === "skipped-fresh") {
      // Pull existing timings into the manifest.
      const onDisk = await readTimingsFromDisk(chapter, bullet);
      if (onDisk) {
        sceneEntries.set(key, {
          duration: onDisk.durationSeconds,
          words: onDisk.words,
          sourceText: onDisk.sourceText,
        });
      }
      console.log(`  skip   ${label}`);
      skipped++;
    } else if (r.durationSeconds !== undefined && r.words !== undefined) {
      sceneEntries.set(key, {
        duration: r.durationSeconds,
        words: r.words,
        sourceText: bullet.body,
      });
      const kb = ((r.bytes ?? 0) / 1024).toFixed(1);
      const dt = ((Date.now() - start) / 1000).toFixed(1);
      const dur = (r.durationSeconds ?? 0).toFixed(1);
      const tag =
        r.status === "regenerated" ? "regen (text-changed)" : "ok (first-time)";
      console.log(
        `  ${tag.padEnd(20)} ${label} — ${kb} KB · ${(r.words ?? []).length} words · ${dur}s audio · ${dt}s api`,
      );
      generated++;
      if (r.status === "regenerated") textChangedRegens++;
      totalBytes += r.bytes ?? 0;
    }
  }

  await writeManifest(sceneEntries);

  console.log(
    `\ndone · generated=${generated} (${textChangedRegens} from text changes) · ` +
      `skipped=${skipped} · ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
