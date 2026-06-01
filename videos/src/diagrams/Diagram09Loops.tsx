/**
 * §9 — When things fail, worca self-corrects inside bounded loops.
 *
 * Visual: Tester and Implementer with a curved bidirectional arrow loop
 * between them. An iteration counter above ticks up (1 → 2 → 3 → MAX),
 * and a circuit breaker badge "trips" when the cap is hit. An effort
 * badge climbs the rungs (medium → high → max) on the side.
 *
 *      ITERATION 3 / 5
 *         (counter)
 *   ┌──────────┐ ↻ ↩  ┌──────────┐
 *   │Implementer│ ⇄   │  Tester  │
 *   └──────────┘     └──────────┘
 *           ⚠  circuit breaker
 *           effort: medium → high → max
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Node } from "./primitives";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

const NODE_W = 260;
const NODE_H = 130;
const NODE_GAP = 200;
const COUNTER_H = 80;
const FOOTER_H = 100;
const TOTAL_W = NODE_W * 2 + NODE_GAP;
const TOTAL_H = COUNTER_H + NODE_H + FOOTER_H;

const NODE_Y = COUNTER_H;
const IMP_X = 0;
const TEST_X = NODE_W + NODE_GAP;
const NODE_CENTER_Y = NODE_Y + NODE_H / 2;

export const Diagram09Loops: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  // Cue each element to its line of narration.
  // Script: "If tests fail, the tester sends the failure back to the
  //          implementer, and the implementer tries again. … Each loop
  //          has a maximum number of iterations. A circuit breaker
  //          watches for patterns… If a task keeps looping back, the
  //          next pass runs at a higher reasoning level."
  const testerStart = cueFrame(2, 9, "tester", {
    fallback: 40,
    offsetFrames: -6,
  });
  const implementerStart = cueFrame(2, 9, "implementer", {
    fallback: 18,
    offsetFrames: -6,
  });
  const arrowStart = cueFrame(2, 9, "back", {
    fallback: 60,
    offsetFrames: -6,
  });
  const iterStart = cueFrame(2, 9, "iterations", {
    fallback: 90,
    offsetFrames: -6,
  });
  const effortStart = cueFrame(2, 9, "reasoning", {
    fallback: 200,
    offsetFrames: -6,
  });
  const cbStart = cueFrame(2, 9, "circuit", {
    fallback: 280,
    offsetFrames: -6,
  });

  const impReveal = useReveal({ startFrame: implementerStart });
  const testReveal = useReveal({ startFrame: testerStart });
  const arrowReveal = useReveal({ startFrame: arrowStart });
  const counterReveal = useReveal({ startFrame: iterStart });
  const cbReveal = useReveal({ startFrame: cbStart });
  const effortReveal = useReveal({ startFrame: effortStart });

  // Iteration counter: 1 → 2 → 3, advancing every ~70f after iterStart.
  const iteration = Math.min(
    3,
    Math.floor(Math.max(0, frame - iterStart - 30) / 70) + 1,
  );
  const tripped = frame >= cbStart;

  // Dash flow on the loop arcs starts when the arrow first appears.
  const arcDashOffset = -((frame - arrowStart) * 1.0);

  // Effort label progression: medium → high (when effort cue lands) →
  // max (when circuit-breaker cue lands).
  const effortStage =
    frame < effortStart ? "medium" : frame < cbStart ? "high" : "max";
  const effortColor =
    effortStage === "max"
      ? theme.accentBright
      : effortStage === "high"
        ? theme.accent
        : theme.text;

  // SVG box covers both nodes
  const arcStartX = IMP_X + NODE_W - 14;
  const arcEndX = TEST_X + 14;
  const arcMidY = NODE_CENTER_Y;

  // Top arc: bezier from (arcStartX, midY) to (arcEndX, midY) bowing up
  const topArcD = `M ${arcStartX} ${arcMidY - 18} C ${arcStartX + 80} ${arcMidY - 100}, ${arcEndX - 80} ${arcMidY - 100}, ${arcEndX} ${arcMidY - 18}`;
  // Bottom arc: bowing down
  const botArcD = `M ${arcEndX} ${arcMidY + 18} C ${arcEndX - 80} ${arcMidY + 100}, ${arcStartX + 80} ${arcMidY + 100}, ${arcStartX} ${arcMidY + 18}`;

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Iteration counter */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: TOTAL_W,
          textAlign: "center",
          opacity: counterReveal.opacity,
          transform: counterReveal.transform,
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 14,
            letterSpacing: "0.20em",
            textTransform: "uppercase",
            color: theme.textSecondary,
            marginBottom: 6,
          }}
        >
          iteration
        </div>
        <div
          style={{
            fontFamily: fonts.display,
            fontSize: 42,
            fontWeight: 800,
            color: tripped ? theme.statusFailed : theme.accent,
            letterSpacing: "-0.02em",
          }}
        >
          {iteration} <span style={{ color: theme.textMuted }}>/</span>{" "}
          <span style={{ color: theme.text }}>3</span>
        </div>
      </div>

      {/* Implementer */}
      <div
        style={{
          position: "absolute",
          left: IMP_X,
          top: NODE_Y,
          opacity: impReveal.opacity,
          transform: impReveal.transform,
        }}
      >
        <Node
          label="Implementer"
          sublabel="WRITES CODE"
          tint="sonnet"
          width={NODE_W}
          height={NODE_H}
        />
      </div>

      {/* Tester */}
      <div
        style={{
          position: "absolute",
          left: TEST_X,
          top: NODE_Y,
          opacity: testReveal.opacity,
          transform: testReveal.transform,
        }}
      >
        <Node
          label="Tester"
          sublabel="RUNS TESTS"
          tint="sonnet"
          width={NODE_W}
          height={NODE_H}
        />
      </div>

      {/* Two curved arrows between nodes (loop) */}
      <svg
        width={TOTAL_W}
        height={TOTAL_H}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          pointerEvents: "none",
          opacity: arrowReveal.opacity,
        }}
      >
        <defs>
          <marker
            id="loop-head-fwd"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={theme.accent} />
          </marker>
          <marker
            id="loop-head-bwd"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={theme.accent} />
          </marker>
        </defs>
        {/* Top arc — impl → tester */}
        <path
          d={topArcD}
          fill="none"
          stroke={theme.accent}
          strokeWidth={3}
          strokeDasharray="12 8"
          strokeDashoffset={arcDashOffset}
          markerEnd="url(#loop-head-fwd)"
        />
        {/* Bottom arc — tester → impl (loopback) */}
        <path
          d={botArcD}
          fill="none"
          stroke={theme.accent}
          strokeWidth={3}
          strokeDasharray="12 8"
          strokeDashoffset={arcDashOffset}
          markerEnd="url(#loop-head-bwd)"
        />
      </svg>

      {/* Effort badge — bottom left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: NODE_Y + NODE_H + 20,
          opacity: effortReveal.opacity,
          transform: effortReveal.transform,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 13,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: theme.textSecondary,
          }}
        >
          effort
        </div>
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: 24,
            fontWeight: 700,
            color: effortColor,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          medium → high → <span style={{ color: theme.accentBright }}>max</span>
        </div>
      </div>

      {/* Circuit breaker badge — bottom right */}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: NODE_Y + NODE_H + 20,
          opacity: cbReveal.opacity,
          transform: cbReveal.transform,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 13,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: theme.textSecondary,
          }}
        >
          circuit breaker
        </div>
        <div
          style={{
            padding: "8px 16px",
            background: tripped ? "rgba(239,68,68,0.18)" : "transparent",
            border: `2px solid ${tripped ? theme.statusFailed : theme.borderLight}`,
            borderRadius: 8,
            fontFamily: fonts.mono,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: tripped ? theme.statusFailed : theme.textSecondary,
          }}
        >
          {tripped ? "tripped — halt" : "armed"}
        </div>
      </div>

    </div>
  );
};
