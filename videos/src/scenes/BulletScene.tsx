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
 *   Big chapter title in Syne, up to 2 lines.
 *
 *   Body paragraph in Outfit, revealed sentence by sentence as the
 *   narration would progress. Body size scales down for longer bullets so
 *   the whole paragraph fits comfortably on one screen.
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
  useVideoConfig,
} from "remotion";

import { Background } from "../components/Background";
import { Wordmark } from "../components/Wordmark";
import { fonts } from "../fonts";
import { theme } from "../theme";
import type { BulletScene as BulletSceneData } from "../lib/script";

interface Props {
  scene: BulletSceneData;
  /** "01 / 18" style scene counter shown top-right. */
  sceneLabel: string;
}

/** Auto-pick a body font size so longer paragraphs still fit on one screen. */
const bodyFontSizeForWords = (words: number): number => {
  if (words <= 60) return theme.sizeBody;            // 60px — short bullets
  if (words <= 90) return theme.sizeBody - 8;        // 52px
  if (words <= 120) return theme.sizeBody - 14;      // 46px
  return theme.sizeBody - 20;                        // 40px — longest bullets (~126 words)
};

/** Naive sentence split — fine for the script we wrote (short declarative
 *  sentences, no abbreviations like "Dr." or "e.g."). */
const splitSentences = (body: string): string[] => {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
};

export const BulletScene: React.FC<Props> = ({ scene, sceneLabel }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const ease = Easing.bezier(...theme.easeOut);

  // ── Top-bar fade-in (0 .. 12f) ─────────────────────────────────────────
  const topOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // ── Title fade-up (8 .. 28f) ───────────────────────────────────────────
  const titleOpacity = interpolate(frame, [8, 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const titleTranslate = interpolate(frame, [8, 28], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // ── Accent rule draws right (20 .. 40f) ────────────────────────────────
  const ruleScaleX = interpolate(frame, [20, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // ── Body sentence reveal ───────────────────────────────────────────────
  // Sentences fade in evenly across the narration window: from frame 40
  // through (durationInFrames - 1.0s). Each sentence gets its own
  // interpolation slot.
  const sentences = splitSentences(scene.body);
  const bodyStart = 40;
  const bodyEnd = Math.max(bodyStart + sentences.length * 10, durationInFrames - fps);
  const sentenceWindow = (bodyEnd - bodyStart) / Math.max(sentences.length, 1);

  const bodyFontSize = bodyFontSizeForWords(scene.words);

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
              letterSpacing: "0.08em",
              color: theme.textSecondary,
              textTransform: "uppercase",
            }}
          >
            {sceneLabel}
          </div>
        </div>

        {/* ── Body block ─────────────────────────────────────────────── */}
        <div
          style={{
            marginTop: 80,
            maxWidth: theme.contentMaxWidth,
            display: "flex",
            flexDirection: "column",
            gap: 40,
          }}
        >
          {/* Accent rule */}
          <div
            style={{
              width: 200,
              height: 6,
              backgroundColor: theme.accent,
              borderRadius: 3,
              transform: `scaleX(${ruleScaleX})`,
              transformOrigin: "left center",
              boxShadow: `0 0 24px ${theme.accentDim}`,
            }}
          />

          {/* Title */}
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
            }}
          >
            {scene.title}
          </h1>

          {/* Body paragraph — sentence-by-sentence reveal */}
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: bodyFontSize,
              fontWeight: theme.weightBody,
              lineHeight: theme.lineHeightBody,
              color: theme.textSecondary,
              marginTop: 32,
            }}
          >
            {sentences.map((sentence, idx) => {
              const startF = bodyStart + idx * sentenceWindow;
              const endF = startF + 12;
              const opacity = interpolate(frame, [startF, endF], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: ease,
              });
              const ty = interpolate(frame, [startF, endF], [16, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: ease,
              });
              return (
                <span
                  key={idx}
                  style={{
                    opacity,
                    display: "inline",
                    transform: `translateY(${ty}px)`,
                  }}
                >
                  {sentence}
                  {idx < sentences.length - 1 ? " " : ""}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
