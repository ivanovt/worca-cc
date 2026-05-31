/**
 * CLI: generate SRT subtitle files for the three videos.
 *
 * Reads bullet data from src/lib/script.ts, computes per-sentence cue
 * timings via src/lib/srt.ts, and writes one .srt per video into
 * videos/captions/. Also writes a README explaining what's there.
 *
 * Run with: npm run captions
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAllSrt } from "../src/lib/srt";
import { chapters } from "../src/lib/script";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "captions");

const README = `# Captions

SRT subtitle files for the three "How worca works" videos. Generated from
the script in \`src/lib/script.ts\` — do not edit by hand. Re-run
\`npm run captions\` after script changes.

Timings are derived from the same 150 wpm baseline as the on-screen
durations in \`src/lib/timing.ts\`, so subtitles will line up with the
rendered video frame-for-frame as long as both files are in sync.

| File | Video | Bullets |
|---|---|---|
| \`video1.srt\` | Introducing worca | 1 – 5 |
| \`video2.srt\` | Inside a worca run | 6 – 12 |
| \`video3.srt\` | Worca in your workflow | 13 – 18 |

These are *not* rendered onto the video itself — the on-screen
visualization is diagram-only by design. Viewers turn captions on in
their player when they want them.
`;

const main = async () => {
  await fs.mkdir(outDir, { recursive: true });
  const all = buildAllSrt();

  for (const num of [1, 2, 3] as const) {
    const outPath = path.join(outDir, `video${num}.srt`);
    await fs.writeFile(outPath, all[num], "utf8");
    const lineCount = all[num].split("\n").filter((l) => l.startsWith("00:")).length;
    const chapter = chapters[num];
    console.log(
      `wrote ${path.relative(projectRoot, outPath)} — Video ${num} "${chapter.title}", ${lineCount} cues`,
    );
  }

  await fs.writeFile(path.join(outDir, "README.md"), README, "utf8");
  console.log(`wrote ${path.relative(projectRoot, path.join(outDir, "README.md"))}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
