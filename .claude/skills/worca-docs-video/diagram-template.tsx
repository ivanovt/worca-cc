/**
 * Diagram<NN><PascalSlug>.tsx — template for a new bullet diagram.
 *
 * Replace:
 *   <NN>           two-digit bullet id (e.g. 18)
 *   <PascalSlug>   PascalCase form of the bullet slug (e.g. Cleanup)
 *   <CHAPTER_NUM>  1 / 2 / 3 / 4 — the chapter the bullet belongs to
 *   <BULLET_ID>    same as the id in script.ts
 *   <CUE_*>        literal words from the bullet's body
 *   <LABEL_*>      one short label per element shown on screen
 *
 * The default layout is a horizontal row of labeled nodes connected by
 * accent-colored arrows with animated dash flow. Each node reveals on
 * its narration cue. After the first render, iterate the visual — keep
 * the cue wiring intact.
 *
 * Brand canon (don't reinvent):
 *   - colors: theme.accent (mint), theme.opus (purple), theme.sonnet (blue)
 *   - text:   fonts.body for labels, fonts.mono for SUB-LABELS
 *   - motion: useReveal() for entry; theme.easeOut for any custom easing
 *   - arrows: Arrow primitive with dashFlow > 0 = animated mint dashes
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { Arrow, Node } from "./primitives";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

// ─── Per-element config ───────────────────────────────────────────────────

// One entry per visible element. Order = narration order. Each cue word
// must appear LITERALLY in the bullet's body in script.ts.
const ELEMENTS: Array<{
  label: string;
  sub?: string;
  cue: string;
  cueOccurrence?: number;
  tint?: "default" | "accent" | "opus" | "sonnet";
}> = [
  { label: "<LABEL_1>", sub: "STEP 1", cue: "<CUE_1>" },
  { label: "<LABEL_2>", sub: "STEP 2", cue: "<CUE_2>" },
  { label: "<LABEL_3>", sub: "STEP 3", cue: "<CUE_3>" },
  // Add more as needed. 3–5 elements is the sweet spot.
];

// ─── Layout (top-left coords inside the diagram container) ────────────────

const NODE_W = 300;
const NODE_H = 140;
const GAP = 60;
const ROW_TOP = 80;
const ARROW_INSET = 6;

// ─── Component ────────────────────────────────────────────────────────────

export const Diagram<NN><PascalSlug>: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  // Cue every element to its spoken word. Fallback strides keep the
  // diagram working even without audio (the placeholder build).
  const FALLBACK_FIRST = 28;
  const FALLBACK_STRIDE = 75;
  const starts = ELEMENTS.map((e, i) =>
    cueFrame(<CHAPTER_NUM>, <BULLET_ID>, e.cue, {
      fallback: FALLBACK_FIRST + i * FALLBACK_STRIDE,
      occurrence: e.cueOccurrence,
      offsetFrames: -4,
    }),
  );
  const reveals = starts.map((startFrame) => useReveal({ startFrame }));

  // Layout
  const totalWidth = NODE_W * ELEMENTS.length + GAP * (ELEMENTS.length - 1);
  const totalHeight = ROW_TOP + NODE_H + 40;
  const nodeCenterY = ROW_TOP + NODE_H / 2;
  const nodeLeft = (i: number) => i * (NODE_W + GAP);
  const nodeRight = (i: number) => nodeLeft(i) + NODE_W;

  return (
    <div style={{ position: "relative", width: totalWidth, height: totalHeight }}>
      {/* Arrows between consecutive elements. Each arrow fades on as the
          next element lands; mint dashes flow at a steady cadence. */}
      {ELEMENTS.slice(0, -1).map((_, i) => {
        const arrowStart = starts[i + 1] + 4;
        const elapsed = Math.max(0, frame - arrowStart);
        return (
          <Arrow
            key={`a-${i}`}
            from={[nodeRight(i) + ARROW_INSET, nodeCenterY]}
            to={[nodeLeft(i + 1) - ARROW_INSET, nodeCenterY]}
            color={theme.accent}
            dashFlow={0.7}
            elapsed={elapsed}
            strokeWidth={3}
            style={{ opacity: elapsed > 0 ? 1 : 0 }}
          />
        );
      })}

      {/* Element cards */}
      {ELEMENTS.map((e, i) => (
        <div
          key={e.label}
          style={{
            position: "absolute",
            left: nodeLeft(i),
            top: ROW_TOP,
            opacity: reveals[i].opacity,
            transform: reveals[i].transform,
          }}
        >
          <Node
            label={e.label}
            sublabel={e.sub}
            tint={e.tint ?? (i === ELEMENTS.length - 1 ? "accent" : "default")}
            width={NODE_W}
            height={NODE_H}
          />
        </div>
      ))}
    </div>
  );
};
