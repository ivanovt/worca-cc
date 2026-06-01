/**
 * CLI: generate ElevenLabs voiceover MP3s + per-word timestamps for every
 * bullet in the script.
 *
 * Reads bullet data from src/lib/script.ts, calls the ElevenLabs
 * `text-to-speech/{voice_id}/with-timestamps` endpoint per bullet, writes
 * the audio to public/voiceover/v{1,2,3}-s{NN}.mp3 and per-word alignment
 * to public/voiceover/v{1,2,3}-s{NN}.timestamps.json.
 *
 * Run with:
 *
 *   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… npm run voiceover
 *
 * Skip-if-exists: a bullet that already has an MP3 is not re-generated.
 * Delete the MP3 (or pass `--force`) to regenerate after a script tweak.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chapters } from "../src/lib/script";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "public", "voiceover");

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

// Voice settings tuned for a product-explainer read: warm + confident, not
// over-emoted. Stability 0.55 keeps the voice consistent across long
// paragraphs; similarity_boost 0.80 keeps the voice's character.
const VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.80,
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
  durationSeconds: number;
  words: WordTimestamp[];
}

const fileBase = (chapter: number, sceneId: number): string =>
  `v${chapter}-s${String(sceneId).padStart(2, "0")}`;

const isWordChar = (c: string): boolean => /[A-Za-z0-9'’\-]/.test(c);

/** Collapse the character-level alignment into word-level timestamps so
 *  callers (the diagram reveal-sync layer) can map text to time without
 *  re-walking the alignment array. */
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

const generateForScene = async (
  chapterNumber: 1 | 2 | 3,
  sceneId: number,
  text: string,
): Promise<{
  skipped: boolean;
  bytes?: number;
  words?: WordTimestamp[];
  durationSeconds?: number;
}> => {
  const base = fileBase(chapterNumber, sceneId);
  const mp3Path = path.join(outDir, `${base}.mp3`);
  const tsPath = path.join(outDir, `${base}.timestamps.json`);

  if (!FORCE) {
    try {
      await fs.access(mp3Path);
      return { skipped: true };
    } catch {
      // not exists — proceed
    }
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`;
  const body = {
    text,
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
      `${base}: ElevenLabs API returned ${res.status}\n${errBody.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as AlignmentResponse;
  if (!data.audio_base64) {
    throw new Error(`${base}: missing audio_base64 in response`);
  }
  const audioBuf = Buffer.from(data.audio_base64, "base64");
  await fs.writeFile(mp3Path, audioBuf);

  const words = buildWordTimestamps(data.alignment);
  // The last character's end time is the total audio duration.
  const lastEnd = data.alignment?.character_end_times_seconds?.slice(-1)[0] ?? 0;
  const durationSeconds =
    lastEnd || (words.length ? words[words.length - 1].endSeconds : 0);

  const timings: SceneTimings = { durationSeconds, words };
  await fs.writeFile(tsPath, JSON.stringify(timings, null, 2));

  return {
    skipped: false,
    bytes: audioBuf.length,
    words,
    durationSeconds,
  };
};

const readTimingsFromTimestamps = async (
  chapter: number,
  sceneId: number,
): Promise<{ duration: number; words: WordTimestamp[] } | null> => {
  const base = fileBase(chapter, sceneId);
  const tsPath = path.join(outDir, `${base}.timestamps.json`);
  try {
    const buf = await fs.readFile(tsPath, "utf8");
    const data = JSON.parse(buf);
    if (Array.isArray(data)) {
      // Legacy format — array of words only.
      const duration = data.length ? data[data.length - 1].endSeconds : 0;
      return { duration, words: data as WordTimestamp[] };
    }
    return {
      duration:
        typeof data.durationSeconds === "number" ? data.durationSeconds : 0,
      words: Array.isArray(data.words) ? (data.words as WordTimestamp[]) : [],
    };
  } catch {
    return null;
  }
};

const writeManifest = async (
  scenes: Map<string, { duration: number; words: WordTimestamp[] }>,
): Promise<void> => {
  const manifestPath = path.join(
    projectRoot,
    "src",
    "lib",
    "audio-manifest.generated.ts",
  );
  const entries = [...scenes.entries()].sort(([a], [b]) => a.localeCompare(b));

  const durationsBody = entries
    .map(([k, v]) => `  "${k}": ${v.duration.toFixed(3)},`)
    .join("\n");

  // Word timestamps are emitted as a more compact tuple form to keep the
  // file small. Each word becomes [word, start, end].
  const wordsBody = entries
    .map(([k, v]) => {
      const inner = v.words
        .map(
          (w) =>
            `    [${JSON.stringify(w.word)}, ${w.startSeconds.toFixed(3)}, ${w.endSeconds.toFixed(3)}]`,
        )
        .join(",\n");
      return `  "${k}": [\n${inner}\n  ],`;
    })
    .join("\n");

  const content = `/**
 * AUTO-GENERATED by scripts/generate-voiceover.ts — do not edit by hand.
 *
 * Two views of the voiceover output:
 *
 *   - audioDurations  — each scene's actual MP3 duration in seconds.
 *                        Used by lib/timing.ts to set scene length.
 *   - wordTimestamps  — per-scene array of [word, startSeconds, endSeconds]
 *                        tuples from the ElevenLabs alignment response.
 *                        Used by lib/cue.ts to make diagram element
 *                        reveals land on the moment a specific word is
 *                        spoken instead of a fixed stride.
 */

export const audioDurations: Record<string, number> = {
${durationsBody}
};

export type WordTuple = [word: string, startSeconds: number, endSeconds: number];

export const wordTimestamps: Record<string, WordTuple[]> = {
${wordsBody}
};

export const hasAudio = (chapter: number, sceneId: number): boolean =>
  \`v\${chapter}-s\${String(sceneId).padStart(2, "0")}\` in audioDurations;

export const audioDuration = (
  chapter: number,
  sceneId: number,
): number | undefined =>
  audioDurations[\`v\${chapter}-s\${String(sceneId).padStart(2, "0")}\`];

export const wordsForScene = (
  chapter: number,
  sceneId: number,
): WordTuple[] | undefined =>
  wordTimestamps[\`v\${chapter}-s\${String(sceneId).padStart(2, "0")}\`];
`;
  await fs.writeFile(manifestPath, content);
  console.log(
    `wrote ${path.relative(projectRoot, manifestPath)} — ${entries.length} entries`,
  );
};

const main = async (): Promise<void> => {
  await fs.mkdir(outDir, { recursive: true });

  console.log(
    `voice ${VOICE_ID} · model ${MODEL_ID} · force=${FORCE}\n` +
      `output: ${path.relative(projectRoot, outDir)}/\n`,
  );

  let totalGenerated = 0;
  let totalSkipped = 0;
  let totalBytes = 0;
  const scenesByKey = new Map<string, { duration: number; words: WordTimestamp[] }>();

  for (const num of [1, 2, 3] as const) {
    if (CHAPTER_FILTER !== null && CHAPTER_FILTER !== num) continue;
    const chapter = chapters[num];
    console.log(`=== Video ${num} — ${chapter.title} ===`);
    for (const scene of chapter.scenes) {
      const start = Date.now();
      const base = fileBase(num, scene.id);
      try {
        const r = await generateForScene(num, scene.id, scene.body);
        if (r.skipped) {
          const existing = await readTimingsFromTimestamps(num, scene.id);
          if (existing !== null) scenesByKey.set(base, existing);
          console.log(`  skip   ${base}`);
          totalSkipped++;
        } else {
          if (r.durationSeconds !== undefined && r.words !== undefined) {
            scenesByKey.set(base, {
              duration: r.durationSeconds,
              words: r.words,
            });
          }
          const kb = ((r.bytes ?? 0) / 1024).toFixed(1);
          const dt = ((Date.now() - start) / 1000).toFixed(1);
          const dur = (r.durationSeconds ?? 0).toFixed(1);
          console.log(
            `  ok     ${base} — ${kb} KB · ${(r.words ?? []).length} words · ${dur}s audio · ${dt}s api`,
          );
          totalGenerated++;
          totalBytes += r.bytes ?? 0;
        }
      } catch (err) {
        console.error(`  FAIL   v${num}-s${scene.id}:`, (err as Error).message);
        process.exit(1);
      }
    }
    console.log("");
  }

  // For a partial run, seed pre-existing scenes from disk so the manifest
  // still covers every bullet we have audio for.
  if (CHAPTER_FILTER !== null) {
    for (const num of [1, 2, 3] as const) {
      if (CHAPTER_FILTER === num) continue;
      for (const scene of chapters[num].scenes) {
        const base = fileBase(num, scene.id);
        if (scenesByKey.has(base)) continue;
        const existing = await readTimingsFromTimestamps(num, scene.id);
        if (existing !== null) scenesByKey.set(base, existing);
      }
    }
  }
  await writeManifest(scenesByKey);

  console.log(
    `done · generated=${totalGenerated} · skipped=${totalSkipped} · ` +
      `${(totalBytes / 1024 / 1024).toFixed(2)} MB total`,
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
