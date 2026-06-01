/**
 * useReveal — staggered fade-up entry for diagram elements.
 *
 * Each call returns the {opacity, transform} for an element that should
 * appear at `startFrame`. Diagrams chain these together so elements
 * cascade in as the narration progresses.
 *
 * Defaults are tuned to be quick but not snappy — 16 frames at 30fps
 * (~530ms), translateY 14px, cubic-bezier(0.16, 1, 0.3, 1).
 */

import { Easing, interpolate, useCurrentFrame } from "remotion";

import { theme } from "../theme";

export interface RevealOptions {
  /** Frame at which the element starts revealing. */
  startFrame: number;
  /** How long the reveal takes (default 16f ≈ 530ms at 30fps). */
  durationFrames?: number;
  /** Pixels the element travels upward as it fades in (default 14). */
  translateY?: number;
}

export interface RevealStyle {
  opacity: number;
  transform: string;
}

export const useReveal = ({
  startFrame,
  durationFrames = 16,
  translateY = 14,
}: RevealOptions): RevealStyle => {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...theme.easeOut);

  const opacity = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    },
  );
  const ty = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [translateY, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    },
  );

  return { opacity, transform: `translateY(${ty}px)` };
};

/** Returns the elapsed frame relative to `startFrame`, clamped to [0, ∞).
 *  Useful for arrow flow animations that progress AFTER an element appears. */
export const useElapsedFrames = (startFrame: number): number => {
  const frame = useCurrentFrame();
  return Math.max(0, frame - startFrame);
};
