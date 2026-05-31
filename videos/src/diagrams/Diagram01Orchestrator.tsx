/**
 * §1 — worca is an orchestrator for your AI coding agent.
 *
 * Visual: a horizontal pipeline of four development steps revealed one at
 * a time as the narration progresses.
 *
 *   Design Doc  →  Implement  →  Tests  →  Review
 *
 * Each step is a Node card. Arrows between them have animated mint dashes
 * flowing left-to-right after each step lands. Narration is ~17s; we pace
 * the four reveals across the central window so the last step settles a
 * few seconds before the scene exits.
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { Arrow, Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const STEPS = [
  { label: "Design doc", sub: "STEP 1" },
  { label: "Implement", sub: "STEP 2" },
  { label: "Tests", sub: "STEP 3" },
  { label: "Review", sub: "STEP 4" },
] as const;

const NODE_W = 300;
const NODE_H = 140;
const GAP = 60;
const ROW_TOP = 60;          // y of node top edges, in the local layout box
const ARROW_INSET = 6;       // tiny gap between node edge and arrow

export const Diagram01Orchestrator: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  // Bullet 1 narration is ~17s. Scene lead-in is 24f, so we land step 1 at
  // frame 28 (~0.9s after scene start) and stride ~2.5s between steps.
  const FIRST = 28;
  const STRIDE = 75;

  const reveals = STEPS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );

  // Layout in top-left coords inside the diagram container.
  const totalWidth = NODE_W * STEPS.length + GAP * (STEPS.length - 1);
  const totalHeight = ROW_TOP + NODE_H + 40;
  const nodeY = ROW_TOP;
  const nodeCenterY = nodeY + NODE_H / 2;
  const nodeLeft = (i: number) => i * (NODE_W + GAP);
  const nodeRight = (i: number) => nodeLeft(i) + NODE_W;

  return (
    <div
      style={{
        position: "relative",
        width: totalWidth,
        height: totalHeight,
      }}
    >
      {/* Arrows between consecutive steps. Each arrow fades on as the
          next step lands; the dashes then flow at a steady cadence. */}
      {STEPS.slice(0, -1).map((_, i) => {
        const arrowStart = FIRST + (i + 1) * STRIDE - 6;
        const elapsed = Math.max(0, frame - arrowStart);
        const visible = elapsed > 0 ? 1 : 0;
        return (
          <Arrow
            key={`a-${i}`}
            from={[nodeRight(i) + ARROW_INSET, nodeCenterY]}
            to={[nodeLeft(i + 1) - ARROW_INSET, nodeCenterY]}
            color={theme.accent}
            dashFlow={0.9}
            elapsed={elapsed}
            strokeWidth={3}
            style={{ opacity: visible }}
          />
        );
      })}

      {/* Step cards */}
      {STEPS.map((s, i) => (
        <div
          key={s.label}
          style={{
            position: "absolute",
            left: nodeLeft(i),
            top: nodeY,
            opacity: reveals[i].opacity,
            transform: reveals[i].transform,
          }}
        >
          <Node
            label={s.label}
            sublabel={s.sub}
            tint={i === STEPS.length - 1 ? "accent" : "default"}
            width={NODE_W}
            height={NODE_H}
          />
        </div>
      ))}
    </div>
  );
};
