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

  // Sizes (px) — tuned for a 1920x1080 canvas with comfortable readability
  sizeWordmark: 56 * SCALE,
  sizeChapterEyebrow: 36 * SCALE,
  sizeChapterTitle: 160 * SCALE,
  sizeBulletNumber: 72 * SCALE,
  sizeTitle: 110 * SCALE,
  sizeBody: 60 * SCALE,
  sizeBodySmall: 44 * SCALE,
  sizeCaption: 32 * SCALE,

  weightDisplay: 800,
  weightTitle: 700,
  weightBody: 400,
  weightBodyMedium: 500,

  lineHeightTitle: 1.05,
  lineHeightBody: 1.4,
  letterSpacingTitle: "-0.03em",
  letterSpacingDisplay: "-0.02em",

  // ── Layout ───────────────────────────────────────────────────────────
  // Safe area: 1600x800, leaving 160px gutters horizontally and 140px
  // vertically. Numbers below are gutter values.
  gutterX: 160,
  gutterY: 140,
  contentMaxWidth: 1600,

  // ── Motion ───────────────────────────────────────────────────────────
  // Matches the marketing site's --ease-out: cubic-bezier(0.16, 1, 0.3, 1).
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
} as const;

export type Theme = typeof theme;
