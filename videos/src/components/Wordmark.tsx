/**
 * "WORCA" wordmark with accent dot, matching the marketing-site nav-logo
 * pattern. Sized for use in the top-left of every scene.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";

export const Wordmark: React.FC = () => {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 18,
        fontFamily: fonts.mono,
        fontSize: theme.sizeWordmark,
        fontWeight: 700,
        letterSpacing: "0.12em",
        color: theme.text,
        textTransform: "uppercase",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          backgroundColor: theme.accent,
          boxShadow: `0 0 24px ${theme.accent}`,
        }}
      />
      <span>worca</span>
    </div>
  );
};
