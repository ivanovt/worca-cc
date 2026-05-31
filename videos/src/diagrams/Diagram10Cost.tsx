/**
 * §10 — Every run has a cost, and every run has a budget.
 *
 * Visual: a cost meter at the top showing accumulating spend, and three
 * "knobs" below — effort cap, circuit breaker, model profile — that
 * control how that meter behaves.
 *
 *   COST · $7.40 / $10.00
 *   [▓▓▓▓▓▓▓░░░] ────────────────
 *
 *   ┌──────────────┐ ┌────────────────┐ ┌─────────────────┐
 *   │ Effort cap   │ │ Circuit breaker│ │  Model profile  │
 *   │ LOW MED HIGH │ │     [ON]       │ │   ● Opus stages │
 *   │     ↑ max    │ │                │ │   ● Sonnet step │
 *   └──────────────┘ └────────────────┘ └─────────────────┘
 */

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const METER_W = 1080;
const METER_H = 26;
const KNOB_W = 340;
const KNOB_H = 200;
const KNOB_GAP = 30;
const TOTAL_W = METER_W;
const TOTAL_H = 100 + 60 + KNOB_H;

export const Diagram10Cost: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...theme.easeOut);

  const meterReveal = useReveal({ startFrame: 18 });
  const knobReveal1 = useReveal({ startFrame: 90 });
  const knobReveal2 = useReveal({ startFrame: 170 });
  const knobReveal3 = useReveal({ startFrame: 250 });

  // Meter fill animates upward from 0 to 0.74 over the first second of
  // the cost meter reveal.
  const fillFrac = interpolate(frame, [30, 80], [0, 0.74], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Cost meter */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: METER_W,
          opacity: meterReveal.opacity,
          transform: meterReveal.transform,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 16,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: theme.textSecondary,
            }}
          >
            cost meter
          </div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 26,
              fontWeight: 700,
              color: theme.text,
            }}
          >
            <span style={{ color: theme.accent }}>${(fillFrac * 10).toFixed(2)}</span>
            <span style={{ color: theme.textMuted, margin: "0 10px" }}>/</span>
            <span>$10.00</span>
          </div>
        </div>
        <div
          style={{
            position: "relative",
            width: METER_W,
            height: METER_H,
            background: theme.bgCard,
            border: `1.5px solid ${theme.borderLight}`,
            borderRadius: METER_H / 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${fillFrac * 100}%`,
              background: `linear-gradient(90deg, ${theme.accent} 0%, ${theme.accentBright} 100%)`,
              borderRadius: METER_H / 2,
              boxShadow: `0 0 16px ${theme.accentDim}`,
            }}
          />
        </div>
      </div>

      {/* Knobs row */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 160,
          width: TOTAL_W,
          display: "flex",
          gap: KNOB_GAP,
        }}
      >
        {/* Knob 1 — Effort cap */}
        <KnobCard
          reveal={knobReveal1}
          title="Effort cap"
          subtitle="ceiling on escalation"
        >
          <EffortLadder current="high" cap="high" />
        </KnobCard>

        {/* Knob 2 — Circuit breaker */}
        <KnobCard
          reveal={knobReveal2}
          title="Circuit breaker"
          subtitle="halt on non-convergence"
        >
          <Toggle on />
        </KnobCard>

        {/* Knob 3 — Model profile */}
        <KnobCard
          reveal={knobReveal3}
          title="Model profile"
          subtitle="model per stage"
        >
          <ModelChips />
        </KnobCard>
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────

interface KnobCardProps {
  reveal: { opacity: number; transform: string };
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

const KnobCard: React.FC<KnobCardProps> = ({ reveal, title, subtitle, children }) => (
  <div
    style={{
      width: KNOB_W,
      height: KNOB_H,
      background: theme.bgCard,
      border: `2px solid ${theme.borderLight}`,
      borderRadius: 12,
      padding: "20px 24px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      opacity: reveal.opacity,
      transform: reveal.transform,
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    }}
  >
    <div>
      <div
        style={{
          fontFamily: fonts.body,
          fontSize: 24,
          fontWeight: 600,
          color: theme.text,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 13,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.textSecondary,
        }}
      >
        {subtitle}
      </div>
    </div>
    <div>{children}</div>
  </div>
);

const EffortLadder: React.FC<{ current: string; cap: string }> = () => {
  const rungs = ["low", "medium", "high", "max"];
  const capIdx = 2;
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        fontFamily: fonts.mono,
        fontSize: 14,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {rungs.map((r, i) => (
        <span
          key={r}
          style={{
            padding: "5px 9px",
            borderRadius: 5,
            border: `1.5px solid ${i === capIdx ? theme.accent : theme.borderLight}`,
            background: i === capIdx ? theme.accentDim : "transparent",
            color: i === capIdx ? theme.accent : i > capIdx ? theme.textMuted : theme.textSecondary,
            fontWeight: i === capIdx ? 700 : 500,
          }}
        >
          {r}
        </span>
      ))}
    </div>
  );
};

const Toggle: React.FC<{ on: boolean }> = ({ on }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 16,
    }}
  >
    <div
      style={{
        width: 70,
        height: 36,
        background: on ? theme.accentDim : theme.bgPrimary,
        border: `2px solid ${on ? theme.accent : theme.borderLight}`,
        borderRadius: 18,
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: on ? 36 : 3,
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: on ? theme.accent : theme.textMuted,
          boxShadow: on ? `0 0 12px ${theme.accent}` : "none",
        }}
      />
    </div>
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize: 18,
        fontWeight: 700,
        color: on ? theme.accent : theme.textMuted,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {on ? "on" : "off"}
    </div>
  </div>
);

const ModelChips: React.FC = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    {[
      { name: "Plan", color: theme.opus },
      { name: "Impl", color: theme.sonnet },
      { name: "Test", color: theme.sonnet },
      { name: "Rev", color: theme.opus },
    ].map((c) => (
      <div
        key={c.name}
        style={{
          padding: "5px 10px",
          borderRadius: 5,
          border: `1.5px solid ${c.color}`,
          color: c.color,
          fontFamily: fonts.mono,
          fontSize: 13,
          letterSpacing: "0.06em",
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {c.name}
      </div>
    ))}
  </div>
);
