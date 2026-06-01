---
name: worca-docs-video
description: Author a new chapter for the docs-site video series at docs.worca.dev/introduction/watch. Drafts narration in the established short-sentence style, scaffolds a cue-driven Remotion diagram, registers it in src/lib/script.ts + diagrams/registry.ts, and optionally runs the full build pipeline (voiceover → captions → render → posters → publish). Triggers on "new video", "add a video", "new docs video", "create a video chapter", "worca-docs-video", or any request to add a video chapter to the worca docs site.
---

# Author a docs-site video chapter

This skill owns the workflow from "I have a new topic for the docs videos" through "MP4 published on docs.worca.dev/videos/". It is the docs-video sibling of `worca-docs-diagram` and `worca-docs-publish`.

The video pipeline already exists under `videos/`. This skill **orchestrates** that pipeline — it does not reinvent it. The source of truth for narration is `videos/src/lib/script.ts`; the source of truth for paths is `videos/src/lib/paths.ts`; the entire build is `npm run build:videos`.

## Step 0: No-args mode

If the user invokes the skill with no clear request, print this and stop:

```
/worca-docs-video [--mode=author|build|update-watch]

  author        (default) Draft a new chapter — bullets, slugs, diagram scaffold,
                registry entry. No API calls.
  build         Run the full build pipeline (voiceover → captions → render →
                posters → publish). Requires videos/.env.local with
                ELEVENLABS_API_KEY.
  update-watch  Add a <VideoPlayer> block for an existing chapter to
                docs-site/src/content/docs/introduction/watch.mdx.

Tell me the chapter title and the topics to cover, and I'll draft the script.
```

## Step 1: Read the prerequisites

Read these in order. Do not skip:

1. **`videos/src/lib/script.ts`** — observe the existing `Chapter` and `BulletScene` shapes, see slugs, and see the established narration style of every other bullet. The new chapter must match this voice.
2. **`videos/src/lib/paths.ts`** — every file name flows from a chapter slug + bullet slug. Don't hand-roll paths.
3. **`.claude/skills/worca-docs-video/style-guide.md`** — the narration style rules with concrete dos and don'ts.
4. **`videos/src/diagrams/Diagram01Orchestrator.tsx`** — the canonical cue-driven diagram. Use it as the structural reference for new diagrams.
5. **`videos/src/diagrams/registry.ts`** — confirms how diagrams are registered by bullet id.

## Step 2: Mode `author` — draft the chapter

This is the default mode. Interview the user, then produce file edits.

### 2.1 — Interview

Ask, in this order:

1. **Chapter title** ("Title of Video N"). One short sentence; sets the chapter card.
2. **Chapter slug suggestion** (auto-derive from title; confirm with the user). Kebab-case, no leading number — the `0N-` prefix is added automatically from the chapter number.
3. **Bullet count** (5–7 is the established norm).
4. **For each bullet, three things:**
   - The single big idea (one sentence — this becomes the title).
   - The 3–5 elements the diagram should reveal (these drive the cue words).
   - A slug suggestion (auto-derive; confirm).

Do not interview about narration prose yet — you draft that next.

### 2.2 — Draft the narration

For each bullet, draft a paragraph in the style required by `style-guide.md`. Word count is 50–130; choose by topic depth. Show the user each bullet's draft before writing files. Accept edits.

Pick **one cue word per diagram element** from the narration paragraph — must be a literal word that appears in the bullet's `body` exactly once (or, with `occurrence:` annotated, in a known position). Cue words are how the diagram learns when each element should appear.

### 2.3 — Write the files

When the user approves the bullets, write the following edits:

1. **`videos/src/lib/script.ts`** — append a new `v4`/`v5`/… array following the same shape as `v1`, `v2`, `v3`. Register it in `chapters` with `{ number: N, slug: '<chapter-slug>', title: '<title>', scenes: v<N> }`.

2. **`videos/src/diagrams/Diagram<NN><PascalSlug>.tsx`** — a new file copy-adapted from `diagram-template.tsx` in this skill folder. Has the cue-based reveal scaffold pre-wired against the cue words you chose. The visual is a working N-node placeholder using existing primitives (`Node`, `Arrow`). The author iterates the visual after the first render.

3. **`videos/src/diagrams/registry.ts`** — import and register each new diagram by its bullet id.

4. **`videos/src/Root.tsx`** — register a new `Composition` for the chapter (`Video<N><PascalSlug>`) following the existing three. Set `durationInFrames={chapterDurationFrames(N)}`.

5. **`videos/scripts/render-all.ts`** and **`videos/scripts/generate-posters.ts`** — add the new chapter to the `COMPOSITION_ID` map.

### 2.4 — TypeScript check

After writing files, run `cd videos && npx tsc --noEmit` and report any errors. Do not proceed if it doesn't compile.

### 2.5 — Hand off

Tell the user the chapter is scaffolded and offer to switch to `build` mode.

## Step 3: Mode `build` — run the pipeline

Run the npm scripts in this order. Do not skip any. Show the user the command before running.

```bash
cd videos
npm run voiceover     # only the new chapter's bullets call ElevenLabs;
                       # existing bullets skip-if-fresh via sourceText.
npm run captions      # regenerates .srt + .vtt for all chapters.
npm run render        # produces out/<chapter-id>-<chapter-slug>.mp4.
npm run posters       # one JPG poster per chapter.
npm run publish       # copies MP4 + VTT + poster to
                       # docs-site/public/videos/.
```

Or as one shot:

```bash
cd videos && npm run build:videos
```

### Prerequisites

- `videos/.env.local` exists with `ELEVENLABS_API_KEY=sk_…`. If missing, tell the user to copy `videos/.env.sample` to `videos/.env.local` and fill in their key from elevenlabs.io/app/settings/api-keys. Do not proceed without it.
- The voice id is hardcoded to the brand voice in `scripts/generate-voiceover.ts`. Do not parameterize.

### After build

Report the rendered file sizes and durations. Suggest the user runs `open docs-site/public/videos/<chapter-slug>.mp4` to preview, then move to `update-watch` mode.

## Step 4: Mode `update-watch` — embed on the docs site

Edit **`docs-site/src/content/docs/introduction/watch.mdx`**:

1. Add a `<VideoPlayer>` block for the new chapter at the right index in the page (chapters appear in order).
2. Update the page intro line if needed (e.g., "Three videos" → "Four videos", "eleven minutes" → "fifteen minutes").
3. The block template is in `watch-block-template.mdx` in this skill folder; substitute `{number}`, `{slug}`, `{title}`, `{subtitle}`, `{duration}`.

Verify by running:

```bash
cd docs-site && npm run build
```

Expect the new page assets in `dist/videos/`.

## Step 5: Commit (do NOT push)

The user opens the PR themselves. Stage everything and commit with a message like:

```
feat(videos+docs): add Video N — <chapter title>

- New chapter in videos/src/lib/script.ts with N bullets.
- New Diagram<N><Slug>.tsx + registry entry.
- Composition Video<N><Slug> registered in Root.tsx.
- Build pipeline run; MP4 + VTT + poster published to docs-site/public/videos/.
- watch.mdx updated with the new <VideoPlayer> block.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Branch stays local.

## What this skill will NOT do

- It will not invent a new visual language. The existing brand tokens (`theme.ts`), font choices (Outfit + JetBrains Mono), and motion easing (`theme.easeOut`) are the canon.
- It will not push the branch or open a PR — that's the user's call.
- It will not change the voice id, even if asked to "try a different voice for this chapter". Tell the user the voice id is brand-locked in `generate-voiceover.ts` and direct them to edit that file if they truly want a switch.
- It will not run if `videos/.env.local` is missing in build mode. Hard-fail with the setup instructions.

## Pointers

- Style examples and the full set of dos and don'ts for narration: `style-guide.md` (next to this file).
- Bullet shape: `bullet-template.md`.
- Diagram boilerplate: `diagram-template.tsx`.
- Embed block: `watch-block-template.mdx`.
- Existing voice id (brand-locked): `bbGtsRRKUfYO634UxSjz`. Hardcoded in `videos/scripts/generate-voiceover.ts`.
- Where the build outputs land: `docs-site/public/videos/*.mp4 + *.vtt + *-poster.jpg`.
- The 17 existing bullets are the style reference — read a few before drafting new ones.
