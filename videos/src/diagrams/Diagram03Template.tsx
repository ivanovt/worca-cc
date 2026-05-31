/**
 * §3 — The full flow runs as a pipeline, defined by a template.
 *
 * Visual: a template document at the top with a "defines" arrow pointing
 * down to a 6-stage horizontal pipeline. Stages light up one at a time.
 *
 *           ┌────────────────────┐
 *           │  TEMPLATE          │
 *           │  feature.json      │
 *           └──────────┬─────────┘
 *                      │ defines
 *                      ▼
 *   [Plan]→[Coord]→[Impl]→[Test]→[Review]→[Guard]
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Arrow, DocIcon, Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const STAGES = [
  { label: "Plan", tint: "opus" as const },
  { label: "Coord.", tint: "opus" as const },
  { label: "Impl.", tint: "sonnet" as const },
  { label: "Test", tint: "sonnet" as const },
  { label: "Review", tint: "opus" as const },
  { label: "Guard", tint: "opus" as const },
];

const STAGE_W = 175;
const STAGE_H = 90;
const STAGE_GAP = 22;
const ROW_WIDTH = STAGE_W * STAGES.length + STAGE_GAP * (STAGES.length - 1);

const TEMPLATE_W = 340;
const TEMPLATE_H = 150;
const TEMPLATE_PIPELINE_GAP = 120;
const TOTAL_W = Math.max(ROW_WIDTH, TEMPLATE_W);
const TOTAL_H = TEMPLATE_H + TEMPLATE_PIPELINE_GAP + STAGE_H;

const TEMPLATE_X = (TOTAL_W - TEMPLATE_W) / 2;
const PIPELINE_TOP = TEMPLATE_H + TEMPLATE_PIPELINE_GAP;
const PIPELINE_LEFT = (TOTAL_W - ROW_WIDTH) / 2;

export const Diagram03Template: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  const templateReveal = useReveal({ startFrame: 18 });
  const arrowReveal = useReveal({ startFrame: 50, durationFrames: 14 });

  const FIRST = 80;
  const STRIDE = 36;
  const stageReveals = STAGES.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );

  const stageX = (i: number) => PIPELINE_LEFT + i * (STAGE_W + STAGE_GAP);
  const stageRight = (i: number) => stageX(i) + STAGE_W;
  const stageCenterY = PIPELINE_TOP + STAGE_H / 2;

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Template document */}
      <div
        style={{
          position: "absolute",
          left: TEMPLATE_X,
          top: 0,
          width: TEMPLATE_W,
          height: TEMPLATE_H,
          background: theme.bgCard,
          border: `2px solid ${theme.borderLight}`,
          borderRadius: 12,
          padding: "20px 28px",
          display: "flex",
          alignItems: "center",
          gap: 24,
          opacity: templateReveal.opacity,
          transform: templateReveal.transform,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}
      >
        <DocIcon size={88} color={theme.accent} label="TPL" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 13,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: theme.accent,
              fontWeight: 600,
            }}
          >
            template
          </div>
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: 26,
              fontWeight: 600,
              color: theme.text,
              lineHeight: 1.1,
            }}
          >
            feature.json
          </div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              letterSpacing: "0.1em",
              color: theme.textSecondary,
            }}
          >
            stage list · agent prompts · budgets
          </div>
        </div>
      </div>

      {/* "defines" arrow from template down to pipeline */}
      <div
        style={{
          position: "absolute",
          left: TOTAL_W / 2,
          top: TEMPLATE_H + 12,
          width: 1,
          height: TEMPLATE_PIPELINE_GAP - 24,
          background: theme.borderLight,
          opacity: arrowReveal.opacity,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: TOTAL_W / 2 + 18,
          top: TEMPLATE_H + TEMPLATE_PIPELINE_GAP / 2 - 12,
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: theme.textSecondary,
          opacity: arrowReveal.opacity,
        }}
      >
        defines
      </div>
      {/* Arrowhead at the bottom of the connector */}
      <svg
        width={20}
        height={20}
        style={{
          position: "absolute",
          left: TOTAL_W / 2 - 10,
          top: PIPELINE_TOP - 18,
          opacity: arrowReveal.opacity,
        }}
      >
        <path d="M 0 0 L 20 0 L 10 14 Z" fill={theme.borderLight} />
      </svg>

      {/* Pipeline of stages */}
      {STAGES.slice(0, -1).map((_, i) => {
        const arrowStart = FIRST + (i + 1) * STRIDE - 4;
        const elapsed = Math.max(0, frame - arrowStart);
        return (
          <Arrow
            key={`pa-${i}`}
            from={[stageRight(i) + 3, stageCenterY]}
            to={[stageX(i + 1) - 3, stageCenterY]}
            color={theme.accent}
            dashFlow={0.7}
            elapsed={elapsed}
            strokeWidth={2.5}
            style={{ opacity: elapsed > 0 ? 1 : 0 }}
          />
        );
      })}
      {STAGES.map((s, i) => (
        <div
          key={s.label}
          style={{
            position: "absolute",
            left: stageX(i),
            top: PIPELINE_TOP,
            opacity: stageReveals[i].opacity,
            transform: stageReveals[i].transform,
          }}
        >
          <Node
            label={s.label}
            tint={s.tint}
            width={STAGE_W}
            height={STAGE_H}
          />
        </div>
      ))}
    </div>
  );
};
