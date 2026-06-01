# Captions

SRT + WebVTT subtitle files for the three "How worca works" videos.
Generated from the script in `src/lib/script.ts` — do not edit by hand.
Re-run `npm run captions` after script changes.

Cue timings come from the real ElevenLabs audio durations when an audio
manifest exists (`src/lib/audio-manifest.generated.ts`); otherwise a
150 wpm fallback is used.

| File | Video | Bullets |
|---|---|---|
| `01-introducing-worca.srt` + `.vtt` | Introducing worca | 1 – 5 |
| `02-inside-a-worca-run.srt` + `.vtt` | Inside a worca run | 6 – 12 |
| `03-worca-in-your-workflow.srt` + `.vtt` | Worca in your workflow | 13 – 17 |

These are *not* rendered onto the video itself — the on-screen
visualization is diagram-only by design. Viewers toggle captions in
their player when they want them. The embedded HTML5 player on
docs.worca.dev uses the WebVTT variant.
