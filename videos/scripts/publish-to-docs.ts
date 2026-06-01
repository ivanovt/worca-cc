/**
 * CLI: publish rendered videos + captions + posters to the docs-site so
 * they can be embedded on docs.worca.dev.
 *
 * Copies:
 *   out/<chapter>.mp4               → docs-site/public/videos/<chapter>.mp4
 *   out/posters/<chapter>.jpg       → docs-site/public/videos/<chapter>-poster.jpg
 *   captions/<chapter>.vtt          → docs-site/public/videos/<chapter>.vtt
 *
 * Idempotent. Refuses to copy a missing source file (so a partial build
 * doesn't blank out the published assets — fix the upstream and re-run).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chapters } from "../src/lib/script";
import {
  captionVttPath,
  chapterFileBase,
  posterOutPath,
  videoOutPath,
} from "../src/lib/paths";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..");
const docsVideosDir = path.join(repoRoot, "docs-site", "public", "videos");

const main = async (): Promise<void> => {
  await fs.mkdir(docsVideosDir, { recursive: true });

  let copied = 0;
  let skipped = 0;
  const errors: string[] = [];

  const copyOne = async (
    label: string,
    fromRel: string,
    toBaseName: string,
  ): Promise<void> => {
    const from = path.join(projectRoot, fromRel);
    const to = path.join(docsVideosDir, toBaseName);
    try {
      await fs.access(from);
    } catch {
      errors.push(`missing source: ${fromRel} (skipping ${toBaseName})`);
      skipped++;
      return;
    }
    await fs.copyFile(from, to);
    const stat = await fs.stat(to);
    console.log(`  ${label.padEnd(8)} ${fromRel} → ${path.relative(repoRoot, to)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    copied++;
  };

  for (const num of [1, 2, 3] as const) {
    const chapter = chapters[num];
    const base = chapterFileBase(chapter);
    console.log(`\n=== ${chapter.title} ===`);
    await copyOne("mp4", videoOutPath(chapter), `${base}.mp4`);
    await copyOne("poster", posterOutPath(chapter), `${base}-poster.jpg`);
    await copyOne("vtt", captionVttPath(chapter), `${base}.vtt`);
  }

  console.log(`\ndone · copied=${copied} · skipped=${skipped}`);

  if (errors.length) {
    console.error("\nwarnings:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
