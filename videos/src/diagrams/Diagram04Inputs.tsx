/**
 * §4 — Work inputs differ on detail and on enforcement.
 *
 * Visual: four input documents on the left, the worca container on the
 * right, animated arrows flowing in. Guide gets a NORM stamp + thicker
 * mint arrow to convey normative authority.
 *
 * Layout uses fixed pixel coordinates (no derived widths) so the arrow
 * geometry is obvious at a glance and easy to audit.
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Arrow, DocIcon, Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

interface InputDef {
  label: string;
  sublabel: string;
  iconLabel: string;
  stamp?: string;
  tint: "default" | "accent";
}

const INPUTS: InputDef[] = [
  { label: "Prompt", sublabel: "plain text", iconLabel: "TXT", tint: "default" },
  { label: "GitHub issue", sublabel: "structured", iconLabel: "MD", tint: "default" },
  { label: "Plan file", sublabel: "detailed", iconLabel: "MD", tint: "default" },
  { label: "Guide", sublabel: "normative", iconLabel: "RFC", stamp: "NORM", tint: "accent" },
];

// Fixed layout in the diagram's local coord system.
const DOC_SIZE = 100;
const DOC_W = DOC_SIZE * 0.78;
const LABEL_COL_X = DOC_W + 40;        // label column starts here
const LABEL_COL_W = 220;
const INPUT_COL_END = LABEL_COL_X + LABEL_COL_W;  // 358 — right edge of inputs
const ARROW_START_X = INPUT_COL_END + 20;          // 378
const WORCA_LEFT = 900;                            // big arrow gap
const WORCA_W = 240;
const WORCA_H = 200;
const ROW_H = 110;
const ROW_GAP = 22;
const TOTAL_W = WORCA_LEFT + WORCA_W;
const TOTAL_H = INPUTS.length * ROW_H + (INPUTS.length - 1) * ROW_GAP;

export const Diagram04Inputs: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  const FIRST = 30;
  const STRIDE = 90;
  const inputReveals = INPUTS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );
  const worcaReveal = useReveal({ startFrame: 12 });
  const guideWinsReveal = useReveal({ startFrame: FIRST + 4 * STRIDE - 30 });

  const rowTop = (i: number) => i * (ROW_H + ROW_GAP);
  const rowCenterY = (i: number) => rowTop(i) + ROW_H / 2;

  const worcaTop = (TOTAL_H - WORCA_H) / 2;
  const worcaCenterY = worcaTop + WORCA_H / 2;

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Arrows: from right edge of input column to left edge of worca */}
      {INPUTS.map((input, i) => {
        const arrowStart = FIRST + i * STRIDE + 8;
        const elapsed = Math.max(0, frame - arrowStart);
        const isGuide = input.tint === "accent";
        return (
          <Arrow
            key={`ai-${i}`}
            from={[ARROW_START_X, rowCenterY(i)]}
            to={[WORCA_LEFT - 12, worcaCenterY]}
            color={isGuide ? theme.accent : theme.textSecondary}
            dashFlow={isGuide ? 1.2 : 0.55}
            elapsed={elapsed}
            strokeWidth={isGuide ? 4 : 2.5}
            style={{ opacity: elapsed > 0 ? 1 : 0 }}
          />
        );
      })}

      {/* Input rows */}
      {INPUTS.map((input, i) => (
        <div
          key={input.label}
          style={{
            position: "absolute",
            left: 0,
            top: rowTop(i),
            width: INPUT_COL_END,
            height: ROW_H,
            display: "flex",
            alignItems: "center",
            gap: 40,
            opacity: inputReveals[i].opacity,
            transform: inputReveals[i].transform,
          }}
        >
          <DocIcon
            size={DOC_SIZE}
            color={input.tint === "accent" ? theme.accent : theme.text}
            label={input.iconLabel}
            stamp={input.stamp}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 28,
                fontWeight: 600,
                color: input.tint === "accent" ? theme.accent : theme.text,
              }}
            >
              {input.label}
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 14,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: theme.textSecondary,
              }}
            >
              {input.sublabel}
            </div>
          </div>
        </div>
      ))}

      {/* worca container on the right */}
      <div
        style={{
          position: "absolute",
          left: WORCA_LEFT,
          top: worcaTop,
          opacity: worcaReveal.opacity,
          transform: worcaReveal.transform,
        }}
      >
        <Node
          label="worca"
          sublabel="PIPELINE"
          tint="accent"
          width={WORCA_W}
          height={WORCA_H}
        />
      </div>

      {/* "guide wins" callout under worca container */}
      <div
        style={{
          position: "absolute",
          left: WORCA_LEFT + 12,
          top: worcaTop + WORCA_H + 18,
          opacity: guideWinsReveal.opacity,
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: theme.accent,
        }}
      >
        guide wins
      </div>
    </div>
  );
};
