/**
 * CLI: render one JPG poster per chapter — the still frame the HTML5
 * video player shows before the user clicks play.
 *
 * Picks frame 60 of each composition (~2s into the chapter card, after
 * the title has landed and the underline has drawn in). 1920×1080 JPG,
 * quality default.
 *
 * Output: out/posters/<chapter-id>-<chapter-slug>.jpg
 *
 * Run with: npm run posters
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chapters } from "../src/lib/script";
import { posterOutPath } from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CHAPTER_ARG = process.argv.find((a) => a.startsWith("--chapter="));
const CHAPTER_FILTER = CHAPTER_ARG ? Number(CHAPTER_ARG.split("=")[1]) : null;

const COMPOSITION_ID: Record<1 | 2 | 3, string> = {
  1: "Video1Intro",
  2: "Video2InsideRun",
  3: "Video3Workflow",
};

const POSTER_FRAME = 60;

const main = async (): Promise<void> => {
  const posterDir = path.join(projectRoot, "out", "posters");
  await fs.mkdir(posterDir, { recursive: true });

  let rendered = 0;
  let failed = 0;

  for (const num of [1, 2, 3] as const) {
    if (CHAPTER_FILTER !== null && CHAPTER_FILTER !== num) continue;
    const chapter = chapters[num];
    const compId = COMPOSITION_ID[num];
    const outRel = posterOutPath(chapter);

    console.log(`\n=== poster ${compId} @ frame ${POSTER_FRAME} → ${outRel} ===`);

    const result = spawnSync(
      "npx",
      [
        "remotion",
        "still",
        compId,
        outRel,
        `--frame=${POSTER_FRAME}`,
        "--image-format=jpeg",
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.error(`FAIL ${compId} exited with status ${result.status}`);
      failed++;
      continue;
    }
    rendered++;
  }

  console.log(`\ndone · rendered=${rendered} · failed=${failed}`);
  if (failed > 0) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
