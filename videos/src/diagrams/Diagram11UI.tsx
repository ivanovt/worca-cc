/**
 * §11 — Every action and every artifact is traceable in the UI.
 *
 * Visual: a stylized worca-ui browser window with chrome (dots + URL bar)
 * and five panel tabs lighting up one by one — Stages, Iterations, Cost,
 * Tools, Prompts. The first pass of the UI message; §12 zooms in.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

// Each panel pairs with the cue word that triggers its reveal. Script
// (§11): "Stage progression. Iterations. Time spent. Cost. Tool calls.
// Agent prompts and responses."
const PANELS: Array<{ label: string; cue: string }> = [
  { label: "Stages", cue: "stage" },
  { label: "Iterations", cue: "iterations" },
  { label: "Cost", cue: "cost" },
  { label: "Tool calls", cue: "tool" },
  { label: "Prompts", cue: "prompts" },
];

const WIN_W = 1100;
const WIN_H = 500;
const CHROME_H = 56;

export const Diagram11UI: React.FC<DiagramProps> = () => {
  const winReveal = useReveal({ startFrame: 14 });
  const FALLBACK_FIRST = 50;
  const FALLBACK_STRIDE = 32;

  const tabReveals = PANELS.map((p, i) =>
    useReveal({
      startFrame: cueFrame(2, 11, p.cue, {
        fallback: FALLBACK_FIRST + i * FALLBACK_STRIDE,
        offsetFrames: -4,
      }),
    }),
  );

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
      {/* Window chrome */}
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
          {/* Window dots */}
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
          {/* URL pill */}
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
              flex: 1,
              maxWidth: 380,
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
            worca.dev / runs / pipeline-2026-05-31
          </div>
        </div>

        {/* Body — tab grid */}
        <div
          style={{
            padding: "44px 48px",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 24,
            alignContent: "start",
          }}
        >
          {PANELS.map((p, i) => (
            <div
              key={p.label}
              style={{
                padding: "26px 28px",
                background: theme.bgPrimary,
                border: `2px solid ${i < 3 ? theme.accent : theme.borderLight}`,
                borderRadius: 12,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                opacity: tabReveals[i].opacity,
                transform: tabReveals[i].transform,
                boxShadow:
                  i < 3
                    ? `0 0 18px ${theme.accentDim}`
                    : "none",
              }}
            >
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: 26,
                  fontWeight: 600,
                  color: theme.text,
                }}
              >
                {p.label}
              </div>
              {/* placeholder rows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div
                  style={{
                    height: 8,
                    width: "80%",
                    background: theme.border,
                    borderRadius: 4,
                  }}
                />
                <div
                  style={{
                    height: 8,
                    width: "55%",
                    background: theme.border,
                    borderRadius: 4,
                  }}
                />
                <div
                  style={{
                    height: 8,
                    width: "65%",
                    background: theme.border,
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
