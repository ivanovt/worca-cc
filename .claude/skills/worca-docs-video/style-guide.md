# Narration style guide

The 17 existing bullets in `videos/src/lib/script.ts` are the canonical voice. Read three or four before drafting a new one. The rules below are extracted from how those bullets read aloud — not invented from scratch.

## The shape of a bullet

- **50 to 130 words** of body text.
- **Short declarative sentences** — 8 to 15 words is typical, max 20.
- **One idea per sentence.** Split a long sentence into two short ones.
- **Conversational pacing.** Read it aloud; it should feel like an engineer explaining something at a whiteboard.
- **Front-load the point.** First sentence is the headline; everything after is the support.
- **Active voice and second person.** "You can…", "worca runs…", not "It is possible to…".

## What we never do

- **No symbolic notation.** No `→`, no `guide > plan > graph`, no inline backticks for `worca.foo.bar`, no Markdown formatting of any kind. The narrator can't say arrows or angle brackets out loud.
- **No filler.** Drop "basically", "essentially", "you know", "in other words" when the next sentence is going to clarify anyway.
- **No long em-dash asides.** A clause inside em-dashes works on a page; it stalls on audio. Split it into a separate sentence.
- **No abbreviations the narrator can't say cleanly.** `e.g.`, `i.e.` become "for example", "that is". `RFC` is fine — it's pronounceable as letters.
- **No second-time-around hedging.** Once a term is introduced ("a bead"), drop the qualifier ("a small unit of work called a bead" → "a bead"). Each bullet stands alone but the chapter has continuity.

## What we always do

- **Repeat the brand name early.** "worca …" near the start of the first sentence anchors the bullet. We say "worca" a lot on purpose.
- **Name your diagram elements out loud.** If the diagram shows three things called *prompt*, *issue*, *plan*, the narration must say each of those words. The cue-frame helper needs literal matches.
- **End each bullet with a takeaway sentence.** A sentence that lands the point so the next bullet starts fresh. Not a meta-summary ("So that's…") — a content sentence.

## Cue words

Each diagram element needs a **cue word** — a literal word in the body that triggers its reveal. Rules:

- The cue word must appear **exactly** in the body. Hyphens, capitalization, and punctuation in the body are normalized away during lookup, but the word itself must be there.
- Prefer **unique** words. "prompt" appears once → great cue. "stage" appears multiple times → use occurrence index or pick a more specific word.
- Cue words should match the **first natural mention** of the element. If the bullet says "Next up is a GitHub issue", cue on `GitHub` (unique, first appearance), not `issue` (might appear later).
- For revealing UI/diagram elements that don't have a direct word in the narration (e.g. a "guide wins" callout), cue on a phrase fragment that's spoken right before that element should appear (e.g. `wins` from "the guide wins").

When picking cues, write them down for each diagram element before drafting the prose. Then write the prose to make sure each cue appears at the right moment.

## Worked example — bullet §1

> worca is an orchestrator for your AI coding agent. It runs your development process step by step. So the agent always starts with a design document. It always implements and runs the tests. It always performs a code review. Nothing important gets skipped.

What works:
- 43 words.
- Six sentences. Shortest is 4 words, longest is 14.
- Brand name in word 1.
- The four diagram steps (design / implement / tests / review) each get exactly one mention as a cue word.
- Closes with "Nothing important gets skipped" — a content takeaway, not a meta-summary.

A bad version of the same point:

> worca, which is essentially an orchestrator for your AI coding agent, helps you to ensure that the autonomous development process — which involves multiple steps such as design, implementation, testing, and review — is followed end-to-end without anything important being skipped along the way.

What's wrong:
- One 51-word sentence. The narrator runs out of breath.
- "essentially", "ensure that", "along the way" — filler.
- The four diagram steps are jammed into one parenthetical, so cue-word timing is muddied.

## When the bullet feels right

Read your draft out loud at normal speed. If you stumble, breathe mid-sentence, or want to add commas you didn't write — split the sentence. The ElevenLabs narrator is good but its pacing follows the punctuation it sees.

## Length by topic

| Topic depth | Word count |
|---|---|
| Concept beat — one big idea | 35 – 60 |
| Mechanism — names 3-4 concrete things | 60 – 95 |
| Multi-part — walks through 5+ elements or a sequence | 95 – 130 |

The shipped bullets bracket this distribution. Match the topic to the slot.

## Final acid test

Before saving, ask:

1. Could the narrator read this in one take without stumbling?
2. Does every diagram element have a literal cue word in the prose?
3. Is there a takeaway sentence — not a "to summarize" sentence?
4. Did I use the brand name worca at least once?

If yes to all four, the bullet is ready.
