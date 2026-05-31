# Captions

SRT subtitle files for the three "How worca works" videos. Generated from
the script in `src/lib/script.ts` — do not edit by hand. Re-run
`npm run captions` after script changes.

Timings are derived from the same 150 wpm baseline as the on-screen
durations in `src/lib/timing.ts`, so subtitles will line up with the
rendered video frame-for-frame as long as both files are in sync.

| File | Video | Bullets |
|---|---|---|
| `video1.srt` | Introducing worca | 1 – 5 |
| `video2.srt` | Inside a worca run | 6 – 12 |
| `video3.srt` | Worca in your workflow | 13 – 18 |

These are *not* rendered onto the video itself — the on-screen
visualization is diagram-only by design. Viewers turn captions on in
their player when they want them.
