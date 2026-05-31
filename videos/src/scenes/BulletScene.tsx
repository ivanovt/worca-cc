/**
 * BulletScene — renders one bullet from how-it-works.md as a full 1920x1080
 * scene.
 *
 * Layout (top to bottom):
 *
 *   ● WORCA                                                       01 / 18
 *
 *   ─────  (accent rule, animates in)
 *
 *   Big chapter title in Syne, up to 3 lines.
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                                                                     │
 *   │                 DIAGRAM — resolved from src/diagrams/registry.ts    │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Body text is NOT rendered on screen — narration is conveyed by the
 * diagram + voiceover, and subtitles are emitted separately as .srt files
 * (see scripts/generate-srt.ts).
 *
 * Timing: all animations are frame-driven via useCurrentFrame + interpolate.
 * No CSS transitions anywhere.
 */

import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";

import { Background } from "../components/Background";
import { Wordmark } from "../components/Wordmark";
import { fonts } from "../fonts";
import { theme } from "../theme";
import type { BulletScene as BulletSceneData } from "../lib/script";
import { diagramFor } from "../diagrams/registry";

interface Props {
  scene: BulletSceneData;
  /** "01 / 18" style scene counter shown top-right. */
  sceneLabel: string;
}

export const BulletScene: React.FC<Props> = ({ scene, sceneLabel }) => {
  const frame = useCurrentFrame();

  const ease = Easing.bezier(...theme.easeOut);

  // ── Top-bar fade-in (0 .. 12f) ─────────────────────────────────────────
  const topOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // ── Accent rule draws right (10 .. 30f) ────────────────────────────────
  const ruleScaleX = interpolate(frame, [10, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // ── Title fade-up (18 .. 38f) ──────────────────────────────────────────
  const titleOpacity = interpolate(frame, [18, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const titleTranslate = interpolate(frame, [18, 38], [32, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  const Diagram = diagramFor(scene.id);

  return (
    <AbsoluteFill>
      <Background />

      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: `${theme.gutterY}px ${theme.gutterX}px`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* ── Top bar ─────────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            opacity: topOpacity,
          }}
        >
          <Wordmark />
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: theme.sizeCaption,
              fontWeight: 500,
              letterSpacing: "0.10em",
              color: theme.textSecondary,
              textTransform: "uppercase",
            }}
          >
            {sceneLabel}
          </div>
        </div>

        {/* ── Title block ─────────────────────────────────────────────── */}
        <div
          style={{
            marginTop: 56,
            maxWidth: theme.contentMaxWidth,
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div
            style={{
              width: 140,
              height: 5,
              backgroundColor: theme.accent,
              borderRadius: 3,
              transform: `scaleX(${ruleScaleX})`,
              transformOrigin: "left center",
              boxShadow: `0 0 24px ${theme.accentDim}`,
            }}
          />
          <h1
            style={{
              fontFamily: fonts.display,
              fontSize: theme.sizeTitle,
              fontWeight: theme.weightDisplay,
              lineHeight: theme.lineHeightTitle,
              letterSpacing: theme.letterSpacingTitle,
              color: theme.text,
              opacity: titleOpacity,
              transform: `translateY(${titleTranslate}px)`,
              margin: 0,
              maxWidth: theme.contentMaxWidth,
            }}
          >
            {scene.title}
          </h1>
        </div>

        {/* ── Diagram block ───────────────────────────────────────────── */}
        <div
          style={{
            marginTop: 56,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: theme.diagramAreaHeight,
          }}
        >
          <Diagram words={scene.words} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
