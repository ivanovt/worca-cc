/**
 * Brand background.
 *
 * Matches the worca.dev hero: deep navy fill + radial dot grid + a soft
 * accent glow blob. All static — no per-frame animation — so it's cheap
 * to render and reads as a consistent backdrop across every scene.
 */

import React from "react";
import { AbsoluteFill } from "remotion";

import { theme } from "../theme";

export const Background: React.FC<{ glow?: boolean }> = ({ glow = true }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bgDeep }}>
      {/* Dot grid */}
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${theme.border} 1px, transparent 0)`,
          backgroundSize: "60px 60px",
          opacity: 0.6,
        }}
      />

      {/* Accent glow blob, top-right */}
      {glow ? (
        <div
          style={{
            position: "absolute",
            top: -400,
            right: -400,
            width: 1400,
            height: 1400,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${theme.accentGlow} 0%, transparent 65%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
