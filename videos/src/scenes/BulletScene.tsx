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
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";

import { Background } from "../components/Background";
import { Wordmark } from "../components/Wordmark";
import { fonts } from "../fonts";
import { theme } from "../theme";
import type { BulletScene as BulletSceneData } from "../lib/script";
import { diagramFor } from "../diagrams/registry";
import { hasAudio } from "../lib/audio-manifest.generated";
import { LEAD_IN_FRAMES } from "../lib/timing";

interface Props {
  scene: BulletSceneData;
  /** "01 / 17" style scene counter shown top-right. */
  sceneLabel: string;
  /** 1 / 2 / 3 — used to resolve the bullet's voiceover audio file. */
  chapterNumber: 1 | 2 | 3;
}

export const BulletScene: React.FC<Props> = ({
  scene,
  sceneLabel,
  chapterNumber,
}) => {
  const frame = useCurrentFrame();

  // Resolve the voiceover audio file for this bullet, if one exists.
  // Pattern: public/voiceover/v{chapter}-s{NN}.mp3
  const audioId = `v${chapterNumber}-s${String(scene.id).padStart(2, "0")}`;
  const audioSrc = hasAudio(chapterNumber, scene.id)
    ? staticFile(`voiceover/${audioId}.mp3`)
    : null;

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

      {/* Voiceover audio — plays after LEAD_IN_FRAMES so the title card
          has time to land before narration starts. Wrapping in a Sequence
          with `from` is how Remotion delays media playback. */}
      {audioSrc ? (
        <Sequence from={LEAD_IN_FRAMES} layout="none">
          <Audio src={audioSrc} />
        </Sequence>
      ) : null}

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
