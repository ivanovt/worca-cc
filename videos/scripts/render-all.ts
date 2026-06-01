/**
 * CLI: render every chapter into a content-named MP4.
 *
 * Iterates over `chapters` in lib/script.ts, runs `remotion render` per
 * chapter, and writes out/<chapter-id>-<chapter-slug>.mp4.
 *
 * Flags:
 *   --chapter=N   render only video N
 *   --skip-build  pass through to remotion (assumes bundle is up to date)
 *
 * Run with: npm run render
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import { chapters } from "../src/lib/script";
import { videoOutPath } from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CHAPTER_ARG = process.argv.find((a) => a.startsWith("--chapter="));
const CHAPTER_FILTER = CHAPTER_ARG ? Number(CHAPTER_ARG.split("=")[1]) : null;
const PASSTHROUGH = process.argv.slice(2).filter((a) => !a.startsWith("--chapter="));

/** Map chapter number → Remotion composition id (set in src/Root.tsx). */
const COMPOSITION_ID: Record<1 | 2 | 3, string> = {
  1: "Video1Intro",
  2: "Video2InsideRun",
  3: "Video3Workflow",
};

const main = async (): Promise<void> => {
  const outDir = path.join(projectRoot, "out");
  await fs.mkdir(outDir, { recursive: true });

  let rendered = 0;
  let failed = 0;

  for (const num of [1, 2, 3] as const) {
    if (CHAPTER_FILTER !== null && CHAPTER_FILTER !== num) continue;
    const chapter = chapters[num];
    const compId = COMPOSITION_ID[num];
    const outRel = videoOutPath(chapter);
    const outAbs = path.join(projectRoot, outRel);

    console.log(`\n=== render ${compId} → ${outRel} ===`);

    // Remove any prior render so the dispatcher always emits a fresh file.
    try {
      await fs.unlink(outAbs);
    } catch {
      // No prior file — fine.
    }

    const result = spawnSync(
      "npx",
      ["remotion", "render", compId, outRel, ...PASSTHROUGH],
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
