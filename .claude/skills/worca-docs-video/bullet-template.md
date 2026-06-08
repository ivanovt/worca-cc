# Bullet template

The shape every new entry in `videos/src/lib/script.ts` must follow.

## Schema (TypeScript)

```ts
interface BulletScene {
  id: number;        // global bullet id — continues the existing sequence
  slug: string;      // kebab-case, unique within the chapter
  title: string;     // one short sentence; appears on the bullet's title card
  body: string;      // the narration paragraph (the audio script)
  words: number;     // word count of body, matched to body
}
```

## Drafting checklist

1. **id**: take `Math.max(existing ids) + 1`. Bullets in a chapter are consecutive.
2. **slug**: kebab-case, 1–3 words, content-descriptive. Examples:
   - good — `pipeline-template`, `knowledge-graph`, `cost-and-budget`
   - bad — `bullet-3`, `the-third-thing`, `important-stuff`
3. **title**: complete sentence. Mirrors the `## N. <title>` headings in `docs/how-it-works.md`. Lowercase the brand name (`worca`).
4. **body**: 50–130 words per the style-guide; every diagram-element cue word must appear literally.
5. **words**: count the body and store it. Used by the timing fallback when audio isn't generated yet.

## Example (literal, drop-in)

```ts
{
  id: 18,
  slug: "cleanup",
  title: "Worktrees clean up cleanly when the run is done",
  body:
    "Every run lives in its own git worktree. When the run finishes, that worktree is yours to reuse, archive, or delete. worca tracks every worktree so it never loses track of a stale one. A single command sweeps any worktree whose run completed cleanly. Long-running runs are never touched. So your local git workspace stays tidy even after dozens of pipelines.",
  words: 65,
},
```

## Word count

If you trust your eye, count in your head. If not, this one-liner works:

```bash
echo "Every run lives in its own git worktree. ..." | wc -w
```

Word counts only need to be approximately right — the actual scene length is driven by audio duration once voiceover runs, so the field is mostly a sanity check and a fallback for un-narrated bullets.

## Cue words for the diagram

The diagram you scaffold next needs literal cue words from the body. Pick them BEFORE you finalize the body so you can adjust the prose to make sure each one appears at the right moment.

Example for the bullet above (4 diagram elements):

| Element | Cue word | Where it appears in body |
|---|---|---|
| Worktree icon | `worktree` | first sentence |
| Sweep command badge | `sweeps` | mid-paragraph |
| "untouched" indicator | `untouched` | next-to-last sentence |
| Tidy state | `tidy` | last sentence |

Then verify each cue word appears exactly once (or annotate `occurrence:` on the cueFrame() call if a word appears twice).
