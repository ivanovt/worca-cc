/**
 * §8 — Governance isn't advice — it's enforced at runtime.
 *
 * Visual: three rows, each showing an agent attempting an action, with a
 * hook gate in the middle and the outcome on the right. The first two are
 * BLOCKED (Planner trying to write source, Implementer trying to commit);
 * the third (Guardian committing after review) is ALLOWED.
 *
 *   [Planner]      ──▶  ╳ HOOK ╳  ──▶  BLOCKED
 *   [Implementer]  ──▶  ╳ HOOK ╳  ──▶  BLOCKED
 *   [Guardian]     ──▶  ✓ HOOK ✓  ──▶  ALLOWED
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

type Outcome = "blocked" | "allowed";

interface Row {
  agent: string;
  action: string;
  outcome: Outcome;
}

const ROWS: Row[] = [
  { agent: "Planner", action: "write source.ts", outcome: "blocked" },
  { agent: "Implementer", action: "git commit", outcome: "blocked" },
  { agent: "Guardian", action: "git commit", outcome: "allowed" },
];

const AGENT_W = 230;
const AGENT_H = 90;
const HOOK_W = 130;
const HOOK_H = 90;
const OUTCOME_W = 230;
const OUTCOME_H = 90;
const GAP = 60;
const ROW_GAP = 36;
const ROW_W = AGENT_W + GAP + HOOK_W + GAP + OUTCOME_W;
const TOTAL_W = ROW_W;
const TOTAL_H = ROWS.length * AGENT_H + (ROWS.length - 1) * ROW_GAP;

const AGENT_X = 0;
const HOOK_X = AGENT_W + GAP;
const OUTCOME_X = HOOK_X + HOOK_W + GAP;

export const Diagram08Governance: React.FC<DiagramProps> = () => {
  // Each row cues to the agent name being spoken.
  // Script: "The planner cannot write source files. The implementer
  //          cannot commit. Only the guardian can commit…"
  const FALLBACK_FIRST = 24;
  const FALLBACK_STRIDE = 70;
  const rowStarts = [
    cueFrame(2, 8, "planner", {
      fallback: FALLBACK_FIRST,
      offsetFrames: -4,
    }),
    cueFrame(2, 8, "implementer", {
      fallback: FALLBACK_FIRST + FALLBACK_STRIDE,
      offsetFrames: -4,
    }),
    cueFrame(2, 8, "guardian", {
      fallback: FALLBACK_FIRST + 2 * FALLBACK_STRIDE,
      offsetFrames: -4,
    }),
  ];

  const rowReveals = rowStarts.map((startFrame) => useReveal({ startFrame }));
  // The hook outcome (BLOCKED / ALLOWED) lands ~1s after the agent name.
  const outcomeReveals = rowStarts.map((startFrame) =>
    useReveal({ startFrame: startFrame + 28 }),
  );

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {ROWS.map((row, i) => {
        const rowTop = i * (AGENT_H + ROW_GAP);
        const rowCenterY = rowTop + AGENT_H / 2;
        const isBlocked = row.outcome === "blocked";
        const outcomeColor = isBlocked
          ? theme.statusFailed
          : theme.statusCompleted;
        const outcomeBg = isBlocked
          ? "rgba(239, 68, 68, 0.12)"
          : "rgba(34, 197, 94, 0.14)";

        return (
          <React.Fragment key={i}>
            {/* Agent + action */}
            <div
              style={{
                position: "absolute",
                left: AGENT_X,
                top: rowTop,
                width: AGENT_W,
                height: AGENT_H,
                background: theme.bgCard,
                border: `2px solid ${theme.borderLight}`,
                borderRadius: 10,
                padding: "12px 18px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                opacity: rowReveals[i].opacity,
                transform: rowReveals[i].transform,
              }}
            >
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: 22,
                  fontWeight: 600,
                  color: theme.text,
                }}
              >
                {row.agent}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 14,
                  letterSpacing: "0.06em",
                  color: theme.textSecondary,
                  marginTop: 4,
                }}
              >
                tries to {row.action}
              </div>
            </div>

            {/* Connector line from agent to hook */}
            <div
              style={{
                position: "absolute",
                left: AGENT_X + AGENT_W,
                top: rowCenterY - 1,
                width: GAP,
                height: 2,
                background: theme.borderLight,
                opacity: rowReveals[i].opacity,
              }}
            />

            {/* Hook gate */}
            <div
              style={{
                position: "absolute",
                left: HOOK_X,
                top: rowTop,
                width: HOOK_W,
                height: HOOK_H,
                background: theme.bgPrimary,
                border: `2px solid ${isBlocked ? theme.statusFailed : theme.statusCompleted}`,
                borderRadius: 10,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                opacity: rowReveals[i].opacity,
                transform: rowReveals[i].transform,
                boxShadow: `0 0 18px ${
                  isBlocked ? "rgba(239,68,68,0.25)" : "rgba(34,197,94,0.25)"
                }`,
              }}
            >
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: theme.textSecondary,
                }}
              >
                hook
              </div>
              <div
                style={{
                  fontSize: 30,
                  color: outcomeColor,
                  fontWeight: 800,
                  lineHeight: 1,
                }}
              >
                {isBlocked ? "✕" : "✓"}
              </div>
            </div>

            {/* Connector from hook to outcome */}
            <div
              style={{
                position: "absolute",
                left: HOOK_X + HOOK_W,
                top: rowCenterY - 1,
                width: GAP,
                height: 2,
                background: theme.borderLight,
                opacity: outcomeReveals[i].opacity,
              }}
            />

            {/* Outcome badge */}
            <div
              style={{
                position: "absolute",
                left: OUTCOME_X,
                top: rowTop,
                width: OUTCOME_W,
                height: OUTCOME_H,
                background: outcomeBg,
                border: `2px solid ${outcomeColor}`,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: outcomeReveals[i].opacity,
                transform: outcomeReveals[i].transform,
              }}
            >
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: outcomeColor,
                }}
              >
                {isBlocked ? "blocked" : "allowed"}
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
