/**
 * §7 — Pipelines also define the guardrails.
 *
 * Visual: three horizontal gauges, one per guardrail. Each gauge has a
 * label, a bar with a fill at "current / max", and a small caption with
 * the numeric values. The bars animate from 0 → fill on reveal.
 */

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

interface Limit {
  name: string;
  current: number;
  max: number;
  unit?: string;
}

const LIMITS: Limit[] = [
  { name: "Review rounds", current: 1, max: 3 },
  { name: "Test retries", current: 2, max: 5 },
  { name: "Cost per run", current: 7.4, max: 10, unit: "$" },
];

const GAUGE_W = 600;
const GAUGE_H = 28;
const ROW_GAP = 80;
const ROW_H = 110;
const TOTAL_W = GAUGE_W;
const TOTAL_H = LIMITS.length * ROW_H + (LIMITS.length - 1) * ROW_GAP;

export const Diagram07Guardrails: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...theme.easeOut);

  const FIRST = 24;
  const STRIDE = 80;

  const reveals = LIMITS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {LIMITS.map((limit, i) => {
        const rowTop = i * (ROW_H + ROW_GAP);
        const fillFrac = limit.current / limit.max;
        const fillStart = FIRST + i * STRIDE + 14;
        const fillProgress = interpolate(
          frame,
          [fillStart, fillStart + 26],
          [0, fillFrac],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
        );

        return (
          <div
            key={limit.name}
            style={{
              position: "absolute",
              left: 0,
              top: rowTop,
              width: TOTAL_W,
              opacity: reveals[i].opacity,
              transform: reveals[i].transform,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            {/* Label row */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 18,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: theme.textSecondary,
                  fontWeight: 500,
                }}
              >
                {limit.name}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 22,
                  color: theme.text,
                  fontWeight: 700,
                }}
              >
                <span style={{ color: theme.accent }}>
                  {limit.unit ?? ""}
                  {limit.current}
                </span>
                <span style={{ color: theme.textMuted, margin: "0 8px" }}>/</span>
                <span>
                  {limit.unit ?? ""}
                  {limit.max}
                </span>
              </div>
            </div>

            {/* Track */}
            <div
              style={{
                position: "relative",
                width: GAUGE_W,
                height: GAUGE_H,
                background: theme.bgCard,
                border: `1.5px solid ${theme.borderLight}`,
                borderRadius: GAUGE_H / 2,
                overflow: "hidden",
              }}
            >
              {/* Fill */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${fillProgress * 100}%`,
                  background: `linear-gradient(90deg, ${theme.accent} 0%, ${theme.accentBright} 100%)`,
                  borderRadius: GAUGE_H / 2,
                  boxShadow: `0 0 16px ${theme.accentDim}`,
                }}
              />
              {/* Max marker tick */}
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: -4,
                  bottom: -4,
                  width: 2,
                  background: theme.text,
                  opacity: 0.5,
                }}
              />
            </div>

            {/* Caption */}
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                letterSpacing: "0.10em",
                color: theme.textMuted,
              }}
            >
              max defined by the pipeline template
            </div>
          </div>
        );
      })}
    </div>
  );
};
