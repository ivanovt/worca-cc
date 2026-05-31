/**
 * worca brand tokens for video rendering.
 *
 * Source of truth: the marketing site at /Volumes/Apps/dev/ccexperiments/worca-dev
 * (styles.css :root). Mirroring those values here as typed constants so we can
 * reference them through inline style props without ever loading the marketing
 * CSS into the Remotion bundle.
 *
 * Title and body sizes are tuned for a 1920x1080 canvas with viewers reading
 * on TVs / fullscreen displays: large enough to be comfortable from across a
 * room. Adjust SCALE if a future composition needs a different base size.
 */

const SCALE = 1; // global multiplier for all sizes; bump for tighter or looser layouts

export const theme = {
  // ── Canvas ────────────────────────────────────────────────────────────
  width: 1920,
  height: 1080,
  fps: 30,

  // ── Colors (deep dark — matches worca-dev :root, not [data-theme=light]) ─
  bgDeep: "#050a14",
  bgPrimary: "#070d1a",
  bgCard: "#0c1525",
  bgCardHover: "#101c33",
  bgSurface: "#111d35",
  border: "#162040",
  borderLight: "#1e3060",

  accent: "#00e5a0",          // worca's signature mint-teal
  accentBright: "#33ffc0",
  accentDim: "rgba(0, 229, 160, 0.15)",
  accentGlow: "rgba(0, 229, 160, 0.08)",

  // Model-specific colors — useful for stage diagrams (Opus stages vs Sonnet stages)
  opus: "#a78bfa",
  opusDim: "rgba(167, 139, 250, 0.15)",
  sonnet: "#38bdf8",
  sonnetDim: "rgba(56, 189, 248, 0.15)",

  text: "#e4eaf4",
  textSecondary: "#8494b2",
  textMuted: "#4a5e80",

  // Pipeline-stage status colors (from worca-ui/app/styles.css :root)
  statusRunning: "#3b82f6",   // blue
  statusPaused: "#f59e0b",    // amber
  statusCompleted: "#22c55e", // green
  statusFailed: "#ef4444",    // red
  statusPending: "#94a3b8",   // slate

  // ── Typography ───────────────────────────────────────────────────────
  // Font families are resolved through @remotion/google-fonts loaders in
  // src/fonts.ts — these strings are fallbacks if a loader hasn't run.
  fontDisplay: "'Syne', sans-serif",
  fontBody: "'Outfit', sans-serif",
  fontMono: "'JetBrains Mono', monospace",

  // Sizes (px) — tuned for a 1920x1080 canvas.
  // Bullet title and chapter title were reduced from the first pass to free
  // up vertical room for the per-bullet diagrams that now own most of the
  // canvas. Body text is no longer rendered on screen (subtitles are emitted
  // separately as .srt), so body-* sizes are kept only for any future use.
  sizeWordmark: 48 * SCALE,
  sizeChapterEyebrow: 30 * SCALE,
  sizeChapterTitle: 140 * SCALE,
  sizeBulletNumber: 56 * SCALE,
  sizeTitle: 76 * SCALE,
  sizeBody: 44 * SCALE,
  sizeBodySmall: 36 * SCALE,
  sizeCaption: 26 * SCALE,

  weightDisplay: 800,
  weightTitle: 700,
  weightBody: 400,
  weightBodyMedium: 500,

  lineHeightTitle: 1.05,
  lineHeightBody: 1.4,
  letterSpacingTitle: "-0.03em",
  letterSpacingDisplay: "-0.02em",

  // ── Layout ───────────────────────────────────────────────────────────
  // Tighter than the first pass — the diagram now owns the lower ~60% of
  // the canvas, so the title/topbar block gives back some pixels.
  gutterX: 120,
  gutterY: 80,
  contentMaxWidth: 1680,
  diagramAreaHeight: 620,   // rough vertical budget for the diagram block

  // ── Motion ───────────────────────────────────────────────────────────
  // Matches the marketing site's --ease-out: cubic-bezier(0.16, 1, 0.3, 1).
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
} as const;

export type Theme = typeof theme;
