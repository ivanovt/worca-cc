/**
 * §17 — Notifications you can act on.
 *
 * Visual: a mock Telegram-style chat panel with four messages appearing
 * one after another, then a row of inline action buttons (Pause, Resume,
 * Stop) appears at the bottom.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

interface Msg {
  icon: string;
  text: string;
  /** Optional accent tint for the message bubble border. */
  tone?: "info" | "success" | "warn" | "error";
  /** Cue word from §17 narration that triggers this message. */
  cue: string;
  /** 0-based occurrence index when the cue word appears more than once. */
  cueOccurrence?: number;
}

// Script (§17): "A plan is ready. A pull request has been opened. The
// run has paused. A circuit breaker tripped. … those notifications come
// with inline actions."
const MESSAGES: Msg[] = [
  { icon: "📋", text: "Plan is ready for review", tone: "info", cue: "plan" },
  { icon: "🚀", text: "PR opened: #143 (auth-refactor)", tone: "success", cue: "pull" },
  { icon: "⏸", text: "Run paused at the test gate", tone: "warn", cue: "paused" },
  { icon: "⚠", text: "Circuit breaker tripped on retries", tone: "error", cue: "circuit" },
];

const ACTIONS = ["Pause", "Resume", "Stop"];

const PANEL_W = 760;
const PANEL_H = 600;
const HEADER_H = 60;
const ACTIONS_H = 90;
const MSG_GAP = 16;

const TONE_COLOR: Record<NonNullable<Msg["tone"]>, string> = {
  info: "#3b82f6",
  success: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
};

export const Diagram17Chat: React.FC<DiagramProps> = () => {
  const panelReveal = useReveal({ startFrame: 14 });

  const FALLBACK_FIRST = 60;
  const FALLBACK_STRIDE = 80;
  const msgReveals = MESSAGES.map((m, i) =>
    useReveal({
      startFrame: cueFrame(3, 17, m.cue, {
        fallback: FALLBACK_FIRST + i * FALLBACK_STRIDE,
        occurrence: m.cueOccurrence ?? 0,
        offsetFrames: -4,
      }),
    }),
  );
  // Action buttons land on "actions" in "those notifications come with
  // inline actions".
  const actionsReveal = useReveal({
    startFrame: cueFrame(3, 17, "actions", {
      fallback: FALLBACK_FIRST + MESSAGES.length * FALLBACK_STRIDE,
      offsetFrames: -4,
    }),
  });

  return (
    <div
      style={{
        position: "relative",
        width: PANEL_W,
        height: PANEL_H,
        background: theme.bgCard,
        border: `2px solid ${theme.borderLight}`,
        borderRadius: 16,
        overflow: "hidden",
        opacity: panelReveal.opacity,
        transform: panelReveal.transform,
        boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
      }}
    >
      {/* Header */}
      <div
        style={{
          height: HEADER_H,
          background: theme.bgPrimary,
          borderBottom: `1.5px solid ${theme.borderLight}`,
          display: "flex",
          alignItems: "center",
          padding: "0 22px",
          gap: 14,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: theme.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.bgDeep,
            fontFamily: fonts.mono,
            fontSize: 16,
            fontWeight: 800,
          }}
        >
          w
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: 18,
              fontWeight: 600,
              color: theme.text,
            }}
          >
            worca-bot
          </div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              letterSpacing: "0.10em",
              color: theme.textSecondary,
              textTransform: "uppercase",
            }}
          >
            telegram · always-on
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          padding: "22px 22px 0 22px",
          display: "flex",
          flexDirection: "column",
          gap: MSG_GAP,
        }}
      >
        {MESSAGES.map((m, i) => {
          const tone = m.tone ?? "info";
          const color = TONE_COLOR[tone];
          return (
            <div
              key={i}
              style={{
                background: theme.bgPrimary,
                border: `1.5px solid ${theme.borderLight}`,
                borderLeft: `4px solid ${color}`,
                borderRadius: 10,
                padding: "14px 18px",
                display: "flex",
                alignItems: "center",
                gap: 14,
                opacity: msgReveals[i].opacity,
                transform: msgReveals[i].transform,
              }}
            >
              <div
                style={{
                  fontSize: 24,
                  width: 32,
                  textAlign: "center",
                }}
              >
                {m.icon}
              </div>
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: 22,
                  fontWeight: 500,
                  color: theme.text,
                  lineHeight: 1.3,
                }}
              >
                {m.text}
              </div>
            </div>
          );
        })}
      </div>

      {/* Inline action buttons */}
      <div
        style={{
          position: "absolute",
          left: 22,
          right: 22,
          bottom: 22,
          height: ACTIONS_H,
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: actionsReveal.opacity,
          transform: actionsReveal.transform,
        }}
      >
        {ACTIONS.map((a) => (
          <div
            key={a}
            style={{
              flex: 1,
              height: 64,
              background: theme.accentDim,
              border: `1.5px solid ${theme.accent}`,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: fonts.body,
              fontSize: 22,
              fontWeight: 700,
              color: theme.accent,
              letterSpacing: "0.04em",
              boxShadow: `0 0 16px ${theme.accentDim}`,
            }}
          >
            {a}
          </div>
        ))}
      </div>
    </div>
  );
};
