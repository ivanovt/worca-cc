/**
 * DiagramPlaceholder — branded animated pattern used for bullets that
 * don't yet have a specific diagram. Keeps the video playing as a
 * coherent piece while we build out the bespoke diagrams one by one.
 *
 * Visual: a slow-rotating constellation of 6 mint dots connected by faint
 * lines. Centered in the diagram area. Reads as "worca thinking" without
 * being specific about which bullet's content it represents.
 */

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";

interface Props {
  /** Word count of the bullet — not directly used here, kept for API
   *  parity with the real diagrams. */
  words?: number;
}

const DOTS = 6;
const RADIUS = 180;

export const DiagramPlaceholder: React.FC<Props> = () => {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...theme.easeOut);

  // Slow CCW rotation, one revolution per ~9 seconds at 30fps.
  const rotation = (frame / (30 * 9)) * Math.PI * 2;

  // Gentle pulse on the radius so the constellation "breathes".
  const breathe = interpolate(
    frame % 90,
    [0, 45, 90],
    [1, 1.05, 1],
    { easing: ease },
  );

  const r = RADIUS * breathe;

  // Place dots on a regular polygon, then rotate.
  const points = Array.from({ length: DOTS }, (_, i) => {
    const angle = (i / DOTS) * Math.PI * 2 + rotation;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, i };
  });

  // Stagger each dot's initial fade-in across the first second.
  const dotOpacity = (i: number) =>
    interpolate(frame, [i * 4, i * 4 + 18], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    });

  const linesOpacity = interpolate(frame, [40, 70], [0, 0.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  // Caption fades in after the constellation is fully present.
  const captionOpacity = interpolate(frame, [70, 100], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  return (
    <div
      style={{
        position: "relative",
        width: 600,
        height: 500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width={600}
        height={500}
        viewBox="-300 -250 600 500"
        style={{ overflow: "visible" }}
      >
        {/* lines between every pair of points */}
        {points.map((p, i) =>
          points.slice(i + 1).map((q, j) => (
            <line
              key={`${i}-${j}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={theme.accent}
              strokeWidth={1.5}
              opacity={linesOpacity}
            />
          )),
        )}

        {/* dots */}
        {points.map((p) => (
          <circle
            key={p.i}
            cx={p.x}
            cy={p.y}
            r={9}
            fill={theme.accent}
            opacity={dotOpacity(p.i)}
            style={{
              filter: `drop-shadow(0 0 12px ${theme.accent})`,
            }}
          />
        ))}

        {/* center dot */}
        <circle
          cx={0}
          cy={0}
          r={4}
          fill={theme.text}
          opacity={0.4}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          bottom: -50,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontSize: 18,
          letterSpacing: "0.20em",
          textTransform: "uppercase",
          color: theme.textMuted,
          opacity: captionOpacity,
        }}
      >
        diagram — coming soon
      </div>
    </div>
  );
};
