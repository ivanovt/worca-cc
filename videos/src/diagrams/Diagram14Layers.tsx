/**
 * §14 — You shape worca to your team without forking it.
 *
 * Visual: three concentric layered cards — Template (outer), Per-agent
 * overrides (middle), Guide (innermost). Each layer appears as the
 * narration names it. The Guide layer is mint and clearly outermost-in-
 * priority despite being innermost-in-layout.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

const OUTER_W = 760;
const OUTER_H = 540;
const MIDDLE_W = 580;
const MIDDLE_H = 380;
const INNER_W = 380;
const INNER_H = 220;

export const Diagram14Layers: React.FC<DiagramProps> = () => {
  // Script: "The template picks the overall shape. Per-agent overrides
  //          tune individual stages. And the guide you attach at run
  //          time enforces a spec that nothing else can override."
  const outerReveal = useReveal({
    startFrame: cueFrame(3, 14, "template", {
      fallback: 20,
      offsetFrames: -6,
    }),
  });
  const middleReveal = useReveal({
    startFrame: cueFrame(3, 14, "overrides", {
      fallback: 90,
      offsetFrames: -6,
    }),
  });
  const innerReveal = useReveal({
    startFrame: cueFrame(3, 14, "guide", {
      fallback: 160,
      offsetFrames: -6,
    }),
  });

  return (
    <div style={{ position: "relative", width: OUTER_W, height: OUTER_H }}>
      <Layer
        width={OUTER_W}
        height={OUTER_H}
        x={0}
        y={0}
        reveal={outerReveal}
        title="Template"
        subtitle="overall shape"
        labelPos="topleft"
        borderColor={theme.borderLight}
      />
      <Layer
        width={MIDDLE_W}
        height={MIDDLE_H}
        x={(OUTER_W - MIDDLE_W) / 2}
        y={(OUTER_H - MIDDLE_H) / 2}
        reveal={middleReveal}
        title="Per-agent overrides"
        subtitle="tune one stage"
        labelPos="topleft"
        borderColor={theme.borderLight}
      />
      <Layer
        width={INNER_W}
        height={INNER_H}
        x={(OUTER_W - INNER_W) / 2}
        y={(OUTER_H - INNER_H) / 2}
        reveal={innerReveal}
        title="Guide"
        subtitle="normative · highest authority"
        labelPos="center"
        borderColor={theme.accent}
        glow
        accent
      />
    </div>
  );
};

interface LayerProps {
  x: number;
  y: number;
  width: number;
  height: number;
  reveal: { opacity: number; transform: string };
  title: string;
  subtitle: string;
  labelPos: "topleft" | "center";
  borderColor: string;
  glow?: boolean;
  accent?: boolean;
}

const Layer: React.FC<LayerProps> = ({
  x,
  y,
  width,
  height,
  reveal,
  title,
  subtitle,
  labelPos,
  borderColor,
  glow,
  accent,
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width,
      height,
      background: accent ? `linear-gradient(135deg, ${theme.bgCard} 0%, ${theme.bgCardHover} 100%)` : theme.bgCard,
      border: `2px solid ${borderColor}`,
      borderRadius: 14,
      padding: labelPos === "topleft" ? "22px 28px" : 0,
      display: "flex",
      flexDirection: labelPos === "topleft" ? "column" : "column",
      alignItems: labelPos === "center" ? "center" : "flex-start",
      justifyContent: labelPos === "center" ? "center" : "flex-start",
      gap: 6,
      opacity: reveal.opacity,
      transform: reveal.transform,
      boxShadow: glow
        ? `0 0 32px ${theme.accentDim}, 0 8px 24px rgba(0,0,0,0.4)`
        : "0 8px 24px rgba(0,0,0,0.35)",
    }}
  >
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize: 13,
        letterSpacing: "0.20em",
        textTransform: "uppercase",
        color: accent ? theme.accent : theme.textSecondary,
        fontWeight: 600,
      }}
    >
      {accent ? "highest" : "layer"}
    </div>
    <div
      style={{
        fontFamily: fonts.body,
        fontSize: labelPos === "center" ? 48 : 30,
        fontWeight: 700,
        color: accent ? theme.accent : theme.text,
        lineHeight: 1.1,
        marginTop: labelPos === "center" ? 4 : 0,
      }}
    >
      {title}
    </div>
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize: 14,
        letterSpacing: "0.10em",
        color: theme.textSecondary,
        marginTop: 6,
      }}
    >
      {subtitle}
    </div>
  </div>
);
