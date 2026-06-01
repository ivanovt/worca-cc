/**
 * §12 — What the UI actually exposes.
 *
 * Visual: the same window chrome from §11 but zoomed into a layout of
 * five specific panels — Plan, Stage prompt, Beads, Reviewer verdict,
 * Test output. Each panel highlights as the narration names it.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

interface Panel {
  name: string;
  hint: string;
  /** Cue word from the §12 narration that triggers this panel's reveal. */
  cue: string;
  /** 0 = first match; needed when a cue word appears earlier. */
  cueOccurrence?: number;
  /** Grid placement */
  col: number;
  row: number;
  colSpan?: number;
  rowSpan?: number;
}

// 4-column grid with 2 rows.
// Script (§12): "You can read the generated plan. … You can open any
// stage and read its agent prompt. … You can browse the beads. … You
// can read the reviewer's verdict … You can see test output…"
const PANELS: Panel[] = [
  { name: "Plan", hint: "the full design doc", cue: "plan", col: 1, row: 1, colSpan: 2 },
  { name: "Stage prompt", hint: "what worca asked the agent", cue: "prompt", col: 3, row: 1, colSpan: 2 },
  { name: "Beads", hint: "complexity tiers", cue: "beads", col: 1, row: 2 },
  { name: "Reviewer verdict", hint: "diff + verdict", cue: "verdict", col: 2, row: 2, colSpan: 2 },
  { name: "Tests", hint: "every iteration", cue: "test", col: 4, row: 2 },
];

const WIN_W = 1180;
const WIN_H = 540;
const CHROME_H = 56;
const GRID_PAD = 30;
const GRID_GAP = 16;

export const Diagram12UIDetail: React.FC<DiagramProps> = () => {
  const winReveal = useReveal({ startFrame: 14 });
  const FALLBACK_FIRST = 50;
  const FALLBACK_STRIDE = 50;
  const panelReveals = PANELS.map((p, i) =>
    useReveal({
      startFrame: cueFrame(2, 12, p.cue, {
        fallback: FALLBACK_FIRST + i * FALLBACK_STRIDE,
        occurrence: p.cueOccurrence ?? 0,
        offsetFrames: -4,
      }),
    }),
  );

  // Body area dimensions
  const bodyTop = CHROME_H;
  const bodyH = WIN_H - bodyTop;
  const gridW = WIN_W - GRID_PAD * 2;
  const gridH = bodyH - GRID_PAD * 2;
  const colW = (gridW - GRID_GAP * 3) / 4;
  const rowH = (gridH - GRID_GAP) / 2;

  const cellX = (col: number) => GRID_PAD + (col - 1) * (colW + GRID_GAP);
  const cellY = (row: number) => bodyTop + GRID_PAD + (row - 1) * (rowH + GRID_GAP);

  return (
    <div
      style={{
        position: "relative",
        width: WIN_W,
        height: WIN_H,
        opacity: winReveal.opacity,
        transform: winReveal.transform,
      }}
    >
      {/* Window */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: theme.bgCard,
          border: `1.5px solid ${theme.borderLight}`,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        {/* Title bar */}
        <div
          style={{
            height: CHROME_H,
            background: theme.bgPrimary,
            borderBottom: `1.5px solid ${theme.borderLight}`,
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            gap: 12,
          }}
        >
          {["#ef4444", "#f59e0b", "#22c55e"].map((c) => (
            <div
              key={c}
              style={{
                width: 13,
                height: 13,
                borderRadius: "50%",
                background: c,
                opacity: 0.75,
              }}
            />
          ))}
          <div
            style={{
              marginLeft: 18,
              padding: "6px 18px",
              background: theme.bgDeep,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              fontFamily: fonts.mono,
              fontSize: 14,
              color: theme.textSecondary,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: theme.accent,
                boxShadow: `0 0 8px ${theme.accent}`,
              }}
            />
            run-detail / pipeline-2026-05-31
          </div>
        </div>

        {/* Panels */}
        {PANELS.map((p, i) => {
          const x = cellX(p.col);
          const y = cellY(p.row);
          const w = (p.colSpan ?? 1) * colW + ((p.colSpan ?? 1) - 1) * GRID_GAP;
          const h = (p.rowSpan ?? 1) * rowH + ((p.rowSpan ?? 1) - 1) * GRID_GAP;
          return (
            <div
              key={p.name}
              style={{
                position: "absolute",
                left: x,
                top: y,
                width: w,
                height: h,
                background: theme.bgPrimary,
                border: `2px solid ${theme.accent}`,
                borderRadius: 10,
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                opacity: panelReveals[i].opacity,
                transform: panelReveals[i].transform,
                boxShadow: `0 0 16px ${theme.accentDim}`,
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
                {p.name}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: theme.textSecondary,
                }}
              >
                {p.hint}
              </div>
              {/* placeholder rows */}
              <div
                style={{
                  marginTop: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                <div
                  style={{
                    height: 6,
                    width: "85%",
                    background: theme.border,
                    borderRadius: 3,
                  }}
                />
                <div
                  style={{
                    height: 6,
                    width: "55%",
                    background: theme.border,
                    borderRadius: 3,
                  }}
                />
                <div
                  style={{
                    height: 6,
                    width: "70%",
                    background: theme.border,
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
