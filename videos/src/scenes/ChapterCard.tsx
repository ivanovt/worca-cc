/**
 * ChapterCard — opens and closes each video.
 *
 * Layout:
 *
 *      ● WORCA
 *
 *      VIDEO 1
 *
 *      Introducing worca
 *
 *      How worca works · chapter 1 of 3
 *
 * Used both as the intro card (3s, viewer sees the chapter name) and the
 * outro card (3s, same content fades out as the video ends).
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

interface Props {
  chapterNumber: 1 | 2 | 3;
  chapterTitle: string;
}

export const ChapterCard: React.FC<Props> = ({
  chapterNumber,
  chapterTitle,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const ease = Easing.bezier(...theme.easeOut);

  // For intro: fade in across the first 20f, hold, fade out in the last 12f.
  // For outro: same shape — content settles, then fades.
  const fadeIn = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 18, durationInFrames - 2],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    },
  );
  const opacity = Math.min(fadeIn, fadeOut);

  const titleTranslate = interpolate(frame, [4, 26], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

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
          justifyContent: "center",
          opacity,
        }}
      >
        <div style={{ marginBottom: 80 }}>
          <Wordmark />
        </div>

        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: theme.sizeChapterEyebrow,
            fontWeight: 600,
            letterSpacing: "0.24em",
            color: theme.accent,
            textTransform: "uppercase",
            marginBottom: 32,
          }}
        >
          Video {chapterNumber}
        </div>

        <h1
          style={{
            fontFamily: fonts.display,
            fontSize: theme.sizeChapterTitle,
            fontWeight: theme.weightDisplay,
            lineHeight: theme.lineHeightTitle,
            letterSpacing: theme.letterSpacingTitle,
            color: theme.text,
            margin: 0,
            transform: `translateY(${titleTranslate}px)`,
            maxWidth: theme.contentMaxWidth,
            // Gradient from text → accent, matching the marketing-site h1.
            background: `linear-gradient(135deg, ${theme.text} 30%, ${theme.accent} 100%)`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          {chapterTitle}
        </h1>

        <div
          style={{
            marginTop: 60,
            fontFamily: fonts.body,
            fontSize: theme.sizeBodySmall,
            fontWeight: theme.weightBody,
            color: theme.textSecondary,
            letterSpacing: "0.04em",
          }}
        >
          How worca works
        </div>
      </div>
    </AbsoluteFill>
  );
};
