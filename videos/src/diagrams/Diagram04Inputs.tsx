/**
 * §4 — Work inputs differ on detail and on enforcement.
 *
 * Visual: four input documents on the left, the worca container on the
 * right, animated arrows flowing in.
 *
 *   prompt       ─────►
 *   issue        ─────►   ┌──────────┐
 *   plan file    ─────►   │  worca   │
 *                         └──────────┘
 *   guide        ═NORM══►  (separated; guide is normative)
 *
 * Reveal cadence matches the four input types in narration order. The
 * guide gets a distinct styling — accent border, "NORMATIVE" stamp,
 * thicker arrow — to convey that it overrides the others.
 *
 * Bullet 4 is the longest in the series at ~50s. Stride is ~9s per
 * reveal, leaving room for the "guide wins" beat at the end.
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
  /** Doc icon label (small text inside the paper). */
  iconLabel: string;
  /** "NORMATIVE" stamp shown on the guide. */
  stamp?: string;
  tint: "default" | "accent";
}

const INPUTS: InputDef[] = [
  { label: "Prompt", sublabel: "plain text", iconLabel: "TXT", tint: "default" },
  { label: "GitHub issue", sublabel: "structured", iconLabel: "MD", tint: "default" },
  { label: "Plan file", sublabel: "detailed", iconLabel: "MD", tint: "default" },
  { label: "Guide", sublabel: "normative", iconLabel: "RFC", stamp: "NORM", tint: "accent" },
];

const DOC_SIZE = 110;
const ROW_HEIGHT = 110;
const ROW_GAP = 24;
const COL_GAP = 80;          // gap between doc icon and label
const WORCA_W = 240;
const WORCA_H = 200;

export const Diagram04Inputs: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  // §4 narration is ~50s. Lead-in 0.8s = 24f. Reveal first input at f30,
  // then stride 90f (~3s — leaves clear room before the next one).
  const FIRST = 30;
  const STRIDE = 90;
  const inputReveals = INPUTS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );
  // worca container appears very early so the inputs visibly flow INTO it.
  const worcaReveal = useReveal({ startFrame: 12 });
  // "guide wins" callout — fades in after the guide arrow has connected.
  const guideWinsReveal = useReveal({ startFrame: FIRST + 4 * STRIDE + 10 });

  // Layout
  const leftColW = DOC_SIZE * 0.78 + COL_GAP + 240; // doc + gap + label block
  const totalWidth = leftColW + 220 /* arrow zone */ + WORCA_W;
  const totalHeight = INPUTS.length * ROW_HEIGHT + (INPUTS.length - 1) * ROW_GAP;

  const rowTop = (i: number) => i * (ROW_HEIGHT + ROW_GAP);
  const rowCenterY = (i: number) => rowTop(i) + ROW_HEIGHT / 2;

  const worcaTop = (totalHeight - WORCA_H) / 2;
  const worcaLeft = totalWidth - WORCA_W;
  const worcaCenterY = worcaTop + WORCA_H / 2;

  return (
    <div
      style={{
        position: "relative",
        width: totalWidth,
        height: totalHeight,
      }}
    >
      {/* Arrows from each input row INTO the worca container. */}
      {INPUTS.map((input, i) => {
        const arrowStart = FIRST + i * STRIDE + 8;
        const elapsed = Math.max(0, frame - arrowStart);
        const visible = elapsed > 0 ? 1 : 0;
        const isGuide = input.tint === "accent";
        return (
          <Arrow
            key={`ai-${i}`}
            from={[leftColW + 240 + 8, rowCenterY(i)]}
            to={[worcaLeft - 8, worcaCenterY]}
            color={isGuide ? theme.accent : theme.textSecondary}
            dashFlow={isGuide ? 1.2 : 0.6}
            elapsed={elapsed}
            strokeWidth={isGuide ? 4 : 2.5}
            style={{ opacity: visible }}
          />
        );
      })}

      {/* Input rows — doc icon + label block */}
      {INPUTS.map((input, i) => (
        <div
          key={input.label}
          style={{
            position: "absolute",
            left: 0,
            top: rowTop(i),
            display: "flex",
            alignItems: "center",
            gap: COL_GAP,
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
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 30,
                fontWeight: 600,
                color: input.tint === "accent" ? theme.accent : theme.text,
              }}
            >
              {input.label}
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 15,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: theme.textSecondary,
              }}
            >
              {input.sublabel}
            </div>
          </div>
          {/* extra width spacer so layout left column is uniform */}
          <div style={{ width: Math.max(0, 240 - 240) }} />
        </div>
      ))}

      {/* worca container on the right */}
      <div
        style={{
          position: "absolute",
          left: worcaLeft,
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

      {/* "guide wins" callout — fades in near the end of the bullet,
          underneath the worca container, to land the closing point. */}
      <div
        style={{
          position: "absolute",
          left: worcaLeft + 12,
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
