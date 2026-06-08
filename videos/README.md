# worca docs videos

The Remotion project that produces the three (and counting) video chapters embedded at [docs.worca.dev/introduction/watch](https://docs.worca.dev/introduction/watch).

Every chapter follows the same shape: a brand-coloured backdrop, a wordmark, a chapter title, and a sequence of bullet "scenes" where a short narration is paired with an animated diagram that reveals one element at a time as the relevant words are spoken. The narration runs through ElevenLabs in a brand-locked voice; the captions, posters, and final MP4 ship to the docs site as static assets.

This README covers three things:

1. **Installation** — what you need on disk and in your environment to build a video locally.
2. **How it works** — the moving parts and the lifecycle of a chapter, in plain English.
3. **Step-by-step guide** — the actual commands to add or rebuild a video.

A docs-only conceptual overview of *what* the videos cover (rather than how they're built) lives at [`docs/how-it-works.md`](../docs/how-it-works.md).

---

## 1. Installation

### Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22.x (anything that supports `--env-file-if-exists`) | Runs the build scripts and Remotion. |
| npm | 10.x | Bundled with Node 22. |
| ElevenLabs account | Any tier; the brand voice is on the library plan ($5+/mo) | Source of the narration audio. |
| Disk | ~500 MB free | Remotion download + Chrome headless + node_modules. |

Confirm Node first:

```bash
node --version    # expect v22.x
```

### One-time setup

```bash
cd videos
npm install
```

The first install pulls Remotion, Chrome-for-rendering, and the brand fonts via `@remotion/google-fonts`. Total ~300 MB on disk.

Create your local secret file:

```bash
cp .env.sample .env.local
# then edit .env.local and paste your key
```

Get a key at [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys). `.env.local` is gitignored — never commit it.

You're now ready. Try a sanity check:

```bash
npm run voiceover    # should print "skipped=17 · 0.00 MB" — no API calls
```

If that succeeds, every other command in this project will work.

---

## 2. How it works

### The shape of a video

Each video on docs.worca.dev/introduction/watch is one **chapter**. A chapter is a top-and-tail (a chapter-title card before and after) wrapping a sequence of **bullets**. A bullet is one screen: a title, an animated diagram, and ~20–50 seconds of narration. The current series has three chapters and seventeen bullets total.

The bullet is the unit of authoring. When you write a new video, you're really writing N bullets.

### What makes a bullet

A bullet declares four things in `src/lib/script.ts`:

- **A title** — one short sentence that lands on the title card.
- **A slug** — a short kebab-case identifier that drives every filename downstream.
- **A body** — the narration paragraph. 50–130 words. Short sentences, no symbolic notation. The style guide in [`.claude/skills/worca-docs-video/style-guide.md`](../.claude/skills/worca-docs-video/style-guide.md) has the rules and worked examples.
- **A diagram** — a small TSX component that visualises the bullet's idea. The diagram's elements reveal one at a time, each pinned to a specific word ("cue word") in the body.

Once these four pieces exist, every other artifact is derived: the audio file is the body read aloud, the captions are the body broken into sentences with timings from the audio, and the video is the title-card and diagram composited with the audio underneath.

### The pipeline, conceptually

The build moves a bullet through five stages, each with a single npm script. They run in order; later stages depend on earlier ones.

1. **Voiceover** — sends each bullet's body to ElevenLabs and saves the returned MP3 alongside word-level timings. Runs only on bullets whose body has changed since the last run (a `sourceText` field saved with the timings catches edits). The voice id is brand-locked in `scripts/generate-voiceover.ts`; only the API key comes from your environment.
2. **Captions** — turns the word timings into one `.srt` and one `.vtt` (WebVTT) file per chapter. The `.vtt` is what the HTML5 video player uses on docs.worca.dev.
3. **Render** — Remotion composites the title card, diagrams, audio, and brand chrome into an MP4 per chapter. Element reveals inside each diagram pin to the cue words via the word-timing manifest produced in step 1, so the visual lands on the narration rather than on a fixed clock.
4. **Posters** — one JPG still per chapter (a frame from the chapter card) used as the poster image before the user clicks play.
5. **Publish** — copies the MP4, the VTT, and the poster into `docs-site/public/videos/`. The Cloudflare-served docs site picks them up on its next build.

Each stage is idempotent. Re-running the whole pipeline after a single bullet edit only re-narrates that bullet, re-renders the affected chapter, and re-publishes that chapter's assets.

### Brand canon — non-negotiable

A small set of design choices is intentionally locked. Don't change these per chapter — change them once and consistently:

- **Voice.** ElevenLabs voice id `bbGtsRRKUfYO634UxSjz`. Hardcoded in `scripts/generate-voiceover.ts`.
- **Fonts.** Outfit at weight 800 for titles; Outfit at lighter weights for labels; JetBrains Mono for wordmark and counters. Loaded via `@remotion/google-fonts` in `src/fonts.ts`.
- **Colour palette.** Mint accent `#00e5a0`; Opus purple `#a78bfa`; Sonnet blue `#38bdf8`; deep navy bg `#050a14`. All in `src/theme.ts`.
- **Motion.** Bezier easing `(0.16, 1, 0.3, 1)` (`theme.easeOut`) and short fade-up entries via `diagrams/useReveal`. No CSS transitions anywhere — Remotion is frame-driven.
- **Layout.** Chapter card → title + dot + duration; bullet scenes → wordmark top-left, title block, then the diagram filling the lower 60% of the canvas.

If a future chapter wants a different visual language, it's a different product — give it its own Remotion project.

### What's committed vs. generated

| Path | Committed? | Why |
|---|---|---|
| `src/**` | yes | Remotion source — the canon. |
| `scripts/**` | yes | Pipeline scripts. |
| `public/voiceover/**/*.mp3` + `.timestamps.json` | yes | Lets a fresh clone re-render videos without spending ElevenLabs credits. ~10 MB. |
| `captions/*.srt` + `*.vtt` | yes | Tiny text artifacts; useful in PR diff. |
| `src/lib/audio-manifest.generated.ts` | yes | Imported by the Remotion source; committed so a fresh clone builds without first running voiceover. |
| `out/**` | gitignored | Rendered MP4s and posters. The "live" copies live in `docs-site/public/videos/`. |
| `.env.local` | gitignored | ElevenLabs API key. |
| `node_modules`, `dist`, `.remotion` | gitignored | Standard build artifacts and caches. |

---

## 3. Step-by-step guide

There are two paths. The skill-driven path is the recommended one — it owns the conventions and writes the boilerplate. The manual path is the same workflow if you want to operate the pieces directly.

### Path A: with the `worca-docs-video` skill (recommended)

From any Claude Code session in this repo:

```
/worca-docs-video
```

The skill interviews you for the chapter title, bullet list, slugs, and diagram elements (with cue words). It drafts each bullet in the brand voice style, writes the entries into `src/lib/script.ts`, scaffolds a working `Diagram<N><Slug>.tsx` per bullet, registers everything in `diagrams/registry.ts` and `Root.tsx`, and offers to run the build pipeline at the end.

The skill is at [`.claude/skills/worca-docs-video/`](../.claude/skills/worca-docs-video/) — open `SKILL.md` to see the exact interview flow and what files it writes.

### Path B: by hand

Use this when you want to make small edits (tweaking a single bullet's wording) without invoking the skill.

#### Add a new bullet to an existing chapter

1. Edit `src/lib/script.ts`. Append a `BulletScene` to the right chapter's array (`v1`, `v2`, `v3`, …). Bump the global `id` so it continues the existing sequence. Add a `slug`, a `title`, a `body`, and a `words` count. The shape and a worked example are in [`.claude/skills/worca-docs-video/bullet-template.md`](../.claude/skills/worca-docs-video/bullet-template.md).
2. Create the diagram. Copy [`.claude/skills/worca-docs-video/diagram-template.tsx`](../.claude/skills/worca-docs-video/diagram-template.tsx) to `src/diagrams/Diagram<NN><PascalSlug>.tsx`. Replace the placeholders. Pick one cue word per visible element — each cue word must appear literally in the bullet's `body`.
3. Register the diagram. Import and add it to the `REGISTRY` map in `src/diagrams/registry.ts`.
4. Build:

   ```bash
   cd videos
   npm run voiceover     # narrates the new bullet (API call); skips the rest
   npm run captions      # regenerates .srt + .vtt
   npm run render        # re-renders the chapter that owns the new bullet
   npm run posters       # refreshes the chapter poster
   npm run publish       # copies MP4/VTT/poster into docs-site/public/videos/
   ```

   Or as one shot:

   ```bash
   npm run build:videos
   ```

5. Verify locally:

   ```bash
   open out/02-inside-a-worca-run.mp4    # (or whichever chapter you touched)
   ```

   And from the docs site itself:

   ```bash
   cd ../docs-site
   npm run build
   open dist/introduction/watch/index.html
   ```

#### Add a whole new chapter

Same as adding a bullet, plus:

1. Define a new `Chapter` in `src/lib/script.ts` (`v4: BulletScene[] = …`) and register it under `chapters` with `number: 4`, the slug, the title.
2. Add a new `Composition` to `src/Root.tsx` (`Video4<Slug>`) following the existing three. Set `durationInFrames={chapterDurationFrames(4)}`.
3. Add the chapter to the `COMPOSITION_ID` map in both `scripts/render-all.ts` and `scripts/generate-posters.ts`.
4. Add a `<VideoPlayer>` block to `docs-site/src/content/docs/introduction/watch.mdx`. Template at [`.claude/skills/worca-docs-video/watch-block-template.mdx`](../.claude/skills/worca-docs-video/watch-block-template.mdx).

Then build as above.

#### Rebuild an existing chapter from scratch

```bash
# Force-regenerate one chapter's audio (costs credits).
cd videos
ELEVENLABS_API_KEY=… npx tsx scripts/generate-voiceover.ts --chapter=2 --force

# Re-render and republish that chapter.
npm run render -- --chapter=2
npm run posters -- --chapter=2
npm run publish
```

#### Edit a single bullet's narration

1. Change the `body` text in `src/lib/script.ts`. Optionally update the `words` count (it's a fallback).
2. Run `npm run voiceover` — the `sourceText` field saved in the timestamp JSON detects the change and regenerates only that one bullet.
3. Run `npm run captions && npm run render -- --chapter=N && npm run publish` for the affected chapter.

### Previewing without rendering

Remotion Studio gives you a real-time scrub of every composition:

```bash
cd videos
npm run studio       # opens http://localhost:3000
```

This is the fastest feedback loop for diagram timing and visual tweaks. The narration plays in real time; the cue-driven reveals fire against the cached word timings.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run voiceover` regenerates every bullet | `sourceText` is missing on every timings JSON (legacy or freshly cloned without audio yet) | Either accept the credit spend or run on a single chapter at a time with `--chapter=N`. |
| `ERROR: ELEVENLABS_API_KEY is required` | `.env.local` missing or empty | Copy `.env.sample` to `.env.local` and paste your key. |
| Render produces a black square instead of the chapter card | Fonts didn't load | `npm install` again; Google Fonts loaders need the install to have completed. |
| Diagram element appears at the wrong moment | Cue word doesn't match a literal word in `body`, or appears at an earlier `occurrence` than expected | Open the diagram's TSX, check the `cue` value, and confirm the word is in the body. Add `cueOccurrence: 1` to skip the first match. |
| `npm run publish` reports "missing source" | Render hasn't run yet, or `out/` was cleared | Run `npm run render` first. |

---

## Pointers

- Brand styling reference: [`src/theme.ts`](./src/theme.ts).
- Diagram patterns to copy from: [`src/diagrams/Diagram01Orchestrator.tsx`](./src/diagrams/Diagram01Orchestrator.tsx), [`src/diagrams/Diagram06Pipeline.tsx`](./src/diagrams/Diagram06Pipeline.tsx).
- All file paths are derived from `chapter.slug` + `bullet.slug` in [`src/lib/paths.ts`](./src/lib/paths.ts) — don't hand-roll filenames.
- The Remotion docs ([remotion.dev/docs](https://www.remotion.dev/docs/the-fundamentals)) cover anything in `src/` that this README doesn't.
