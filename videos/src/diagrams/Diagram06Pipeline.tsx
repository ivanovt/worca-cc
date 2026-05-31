/**
 * §6 — The stages run in a clear order, and each one has a job.
 *
 * Visual: the central worca pipeline. Seven stage nodes in a single row,
 * with Opus-tinted "thinking" stages and Sonnet-tinted "doing" stages so
 * the model split is immediately visible:
 *
 *   Planner → Coordinator → Implementer → Tester → Reviewer → Guardian → Learner
 *   (Opus)    (Opus)        (Sonnet)      (Sonnet) (Opus)     (Opus)     (Opus)
 *
 * "Beads" pop out between Coordinator and Implementer as small mint pills,
 * matching the narration "we call those units beads". A PR badge emerges
 * from Guardian.
 *
 * Bullet 6 narration is ~47s. We pace stage reveals across the first ~36s
 * (~5s each) so the last stage lands with ~10s of breathing room for the
 * outro.
 */

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Arrow, Node, type NodeTint } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const STAGES: Array<{ label: string; sub: string; tint: NodeTint }> = [
  { label: "Planner", sub: "OPUS", tint: "opus" },
  { label: "Coordinator", sub: "OPUS", tint: "opus" },
  { label: "Implementer", sub: "SONNET", tint: "sonnet" },
  { label: "Tester", sub: "SONNET", tint: "sonnet" },
  { label: "Reviewer", sub: "OPUS", tint: "opus" },
  { label: "Guardian", sub: "OPUS", tint: "opus" },
  { label: "Learner", sub: "OPUS", tint: "opus" },
];

const NODE_W = 210;
const NODE_H = 130;
const GAP = 30;
const ROW_TOP = 80;
const ARROW_INSET = 4;

const BEAD_COUNT = 4;

export const Diagram06Pipeline: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...theme.easeOut);

  // Reveal cadence
  const FIRST = 30;
  const STRIDE = 60; // 2s per stage @ 30fps

  const reveals = STAGES.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );

  const totalWidth = NODE_W * STAGES.length + GAP * (STAGES.length - 1);
  const totalHeight = ROW_TOP + NODE_H + 160; // room for beads below row
  const nodeCenterY = ROW_TOP + NODE_H / 2;
  const nodeLeft = (i: number) => i * (NODE_W + GAP);
  const nodeRight = (i: number) => nodeLeft(i) + NODE_W;
  const nodeCenter = (i: number) => nodeLeft(i) + NODE_W / 2;

  // Beads — drop below the row, between Coordinator (i=1) and Implementer
  // (i=2). Each bead pops on with a small overshoot one after another, just
  // before the Implementer card lands.
  const beadsStart = FIRST + 1.5 * STRIDE;
  const beadX = (nodeRight(1) + nodeLeft(2)) / 2;
  const beadY = nodeCenterY + 130;

  // PR badge — emerges down-right of Guardian.
  const prReveal = useReveal({
    startFrame: FIRST + 5 * STRIDE + 18,
    translateY: 20,
  });

  return (
    <div
      style={{
        position: "relative",
        width: totalWidth,
        height: totalHeight,
      }}
    >
      {/* Arrows between stages */}
      {STAGES.slice(0, -1).map((_, i) => {
        const arrowStart = FIRST + (i + 1) * STRIDE - 6;
        const elapsed = Math.max(0, frame - arrowStart);
        const visible = elapsed > 0 ? 1 : 0;
        return (
          <Arrow
            key={`pa-${i}`}
            from={[nodeRight(i) + ARROW_INSET, nodeCenterY]}
            to={[nodeLeft(i + 1) - ARROW_INSET, nodeCenterY]}
            color={theme.accent}
            dashFlow={0.7}
            elapsed={elapsed}
            strokeWidth={2.5}
            style={{ opacity: visible }}
          />
        );
      })}

      {/* Stage cards */}
      {STAGES.map((s, i) => (
        <div
          key={s.label}
          style={{
            position: "absolute",
            left: nodeLeft(i),
            top: ROW_TOP,
            opacity: reveals[i].opacity,
            transform: reveals[i].transform,
          }}
        >
          <Node
            label={s.label}
            sublabel={s.sub}
            tint={s.tint}
            width={NODE_W}
            height={NODE_H}
          />
        </div>
      ))}

      {/* Beads — small mint pills appearing under Coordinator→Implementer */}
      {Array.from({ length: BEAD_COUNT }).map((_, i) => {
        const start = beadsStart + i * 10;
        const opacity = interpolate(frame, [start, start + 14], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        });
        const ty = interpolate(frame, [start, start + 14], [-14, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        });
        const offsetX = (i - (BEAD_COUNT - 1) / 2) * 28;
        return (
          <div
            key={`b-${i}`}
            style={{
              position: "absolute",
              left: beadX + offsetX - 9,
              top: beadY + ty,
              width: 18,
              height: 18,
              borderRadius: 9,
              background: theme.accent,
              opacity,
              boxShadow: `0 0 12px ${theme.accent}`,
            }}
          />
        );
      })}

      {/* "beads" label under the bead row */}
      <div
        style={{
          position: "absolute",
          left: beadX - 80,
          top: beadY + 36,
          width: 160,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: theme.textSecondary,
          opacity: interpolate(
            frame,
            [beadsStart + 30, beadsStart + 50],
            [0, 1],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            },
          ),
        }}
      >
        beads
      </div>

      {/* PR badge — emerging from Guardian */}
      <div
        style={{
          position: "absolute",
          left: nodeCenter(5) - 56,
          top: ROW_TOP + NODE_H + 36,
          opacity: prReveal.opacity,
          transform: prReveal.transform,
          padding: "8px 16px",
          borderRadius: 6,
          background: theme.accent,
          color: theme.bgDeep,
          fontFamily: fonts.mono,
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          boxShadow: `0 0 20px ${theme.accentDim}`,
        }}
      >
        PR ↗
      </div>
    </div>
  );
};
