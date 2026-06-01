/**
 * CLI: generate SRT + WebVTT subtitle files for the three videos.
 *
 * Reads bullet data from src/lib/script.ts, computes per-sentence cue
 * timings via src/lib/srt.ts (which uses real audio durations when a
 * voiceover manifest exists, otherwise a 150 wpm fallback), and writes
 * one .srt + one .vtt per video into videos/captions/.
 *
 * Output names match captionSrtPath()/captionVttPath() in lib/paths.ts.
 *
 * Run with: npm run captions
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAllSrt } from "../src/lib/srt";
import { chapters } from "../src/lib/script";
import { captionSrtPath, captionVttPath } from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "captions");

const README = `# Captions

SRT + WebVTT subtitle files for the three "How worca works" videos.
Generated from the script in \`src/lib/script.ts\` — do not edit by hand.
Re-run \`npm run captions\` after script changes.

Cue timings come from the real ElevenLabs audio durations when an audio
manifest exists (\`src/lib/audio-manifest.generated.ts\`); otherwise a
150 wpm fallback is used.

| File | Video | Bullets |
|---|---|---|
| \`01-introducing-worca.srt\` + \`.vtt\` | Introducing worca | 1 – 5 |
| \`02-inside-a-worca-run.srt\` + \`.vtt\` | Inside a worca run | 6 – 12 |
| \`03-worca-in-your-workflow.srt\` + \`.vtt\` | Worca in your workflow | 13 – 17 |

These are *not* rendered onto the video itself — the on-screen
visualization is diagram-only by design. Viewers toggle captions in
their player when they want them. The embedded HTML5 player on
docs.worca.dev uses the WebVTT variant.
`;

/** SRT → WebVTT: header line + period-instead-of-comma in timestamps. */
const srtToVtt = (srt: string): string => {
  const body = srt.replace(
    /(\d\d:\d\d:\d\d),(\d\d\d)/g,
    (_, hms, ms) => `${hms}.${ms}`,
  );
  return `WEBVTT\n\n${body}`;
};

const main = async (): Promise<void> => {
  await fs.mkdir(outDir, { recursive: true });
  const all = buildAllSrt();

  for (const num of [1, 2, 3] as const) {
    const chapter = chapters[num];
    const srt = all[num];
    const vtt = srtToVtt(srt);

    const srtRel = captionSrtPath(chapter);
    const vttRel = captionVttPath(chapter);
    await fs.writeFile(path.join(projectRoot, srtRel), srt, "utf8");
    await fs.writeFile(path.join(projectRoot, vttRel), vtt, "utf8");

    const cueCount = srt.split("\n").filter((l) => l.startsWith("00:")).length;
    console.log(
      `wrote ${srtRel} + ${vttRel.split("/").pop()} — ${chapter.title}, ${cueCount} cues`,
    );
  }

  await fs.writeFile(path.join(outDir, "README.md"), README, "utf8");
  console.log(`wrote ${path.relative(projectRoot, path.join(outDir, "README.md"))}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
