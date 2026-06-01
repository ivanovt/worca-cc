/**
 * §15 — Built-in templates, and your own.
 *
 * Visual: a 2x2 grid of four real built-in templates, each card showing
 * the template name, its description, and the stage chips it activates.
 *
 * Template names match the actual templates shipped in
 * src/worca/templates/. The set chosen here covers the spectrum from
 * full pipeline (feature) → focused (bugfix) → analysis-only
 * (investigate) → minimal (quick-fix), making the variety visible in
 * one frame.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { cueFrame } from "../lib/cue";
import type { DiagramProps } from "./registry";

interface Template {
  /** Exact template id from src/worca/templates/<id>/template.json */
  id: string;
  description: string;
  stages: string[];
  /** Cue word from §15 narration that triggers this card's reveal. */
  cue: string;
  /** Whether the card should be styled as a built-in (mint border on hover)
   *  or as the "yours" custom slot. */
  custom?: boolean;
}

// Verified against src/worca/templates/*/template.json. The script
// introduces them in this exact order: feature → bug-fix → investigate
// → quick-fix → "and several more".
const TEMPLATES: Template[] = [
  {
    id: "feature",
    description: "Full pipeline with plan review and learn",
    stages: ["plan", "review-plan", "coord", "impl", "test", "review", "pr", "learn"],
    cue: "feature",
  },
  {
    id: "bugfix",
    description: "Opus investigates root cause, focused fix",
    stages: ["plan", "coord", "impl", "test", "review", "pr"],
    cue: "skips",
  },
  {
    id: "investigate",
    description: "Analysis only — no implementation changes",
    stages: ["plan", "pr"],
    cue: "investigate",
  },
  {
    id: "quick-fix",
    description: "Minimal — no test, review, or PR",
    stages: ["plan", "impl"],
    cue: "drops",
  },
];

// And a fifth caption at the bottom hints at the rest of the family
// (feature-minor, feature-fast, refactor, test-only) without
// crowding the grid.
const OTHERS = ["feature-minor", "feature-fast", "refactor", "test-only", "+ yours"];

const CARD_W = 580;
const CARD_H = 230;
const GAP = 28;
const TOTAL_W = CARD_W * 2 + GAP;
const TOTAL_H = CARD_H * 2 + GAP + 70; // extra row for OTHERS strip

export const Diagram15Templates: React.FC<DiagramProps> = () => {
  const FALLBACK_FIRST = 20;
  const FALLBACK_STRIDE = 60;
  const reveals = TEMPLATES.map((t, i) =>
    useReveal({
      startFrame: cueFrame(3, 15, t.cue, {
        fallback: FALLBACK_FIRST + i * FALLBACK_STRIDE,
        offsetFrames: -6,
      }),
    }),
  );
  // "AND MORE →" strip lands on "several" in "And several more cover…"
  const othersReveal = useReveal({
    startFrame: cueFrame(3, 15, "several", {
      fallback: FALLBACK_FIRST + TEMPLATES.length * FALLBACK_STRIDE,
      offsetFrames: -6,
    }),
  });

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {TEMPLATES.map((t, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        return (
          <div
            key={t.id}
            style={{
              position: "absolute",
              left: col * (CARD_W + GAP),
              top: row * (CARD_H + GAP),
              width: CARD_W,
              height: CARD_H,
              background: theme.bgCard,
              border: `2px solid ${theme.borderLight}`,
              borderRadius: 14,
              padding: "24px 28px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              opacity: reveals[i].opacity,
              transform: reveals[i].transform,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 26,
                  fontWeight: 700,
                  color: theme.text,
                  lineHeight: 1.1,
                  letterSpacing: "0.02em",
                }}
              >
                {t.id}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: theme.textMuted,
                }}
              >
                built-in
              </div>
            </div>
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 18,
                fontWeight: 400,
                color: theme.textSecondary,
                lineHeight: 1.3,
              }}
            >
              {t.description}
            </div>
            {/* Stage chips */}
            <div
              style={{
                marginTop: "auto",
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              {t.stages.map((s) => (
                <div
                  key={s}
                  style={{
                    padding: "5px 9px",
                    background: theme.bgPrimary,
                    border: `1.5px solid ${theme.borderLight}`,
                    borderRadius: 5,
                    fontFamily: fonts.mono,
                    fontSize: 12,
                    letterSpacing: "0.04em",
                    color: theme.textSecondary,
                    fontWeight: 500,
                  }}
                >
                  {s}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* "and more" strip below the grid */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 2 * (CARD_H + GAP),
          width: TOTAL_W,
          opacity: othersReveal.opacity,
          transform: othersReveal.transform,
          display: "flex",
          alignItems: "center",
          gap: 18,
          paddingLeft: 4,
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 14,
            letterSpacing: "0.20em",
            textTransform: "uppercase",
            color: theme.textSecondary,
          }}
        >
          and more →
        </div>
        {OTHERS.map((o) => {
          const isCustom = o === "+ yours";
          return (
            <div
              key={o}
              style={{
                padding: "8px 14px",
                background: "transparent",
                border: `1.5px solid ${isCustom ? theme.accent : theme.borderLight}`,
                borderRadius: 6,
                fontFamily: fonts.mono,
                fontSize: 14,
                letterSpacing: "0.04em",
                color: isCustom ? theme.accent : theme.textSecondary,
                fontWeight: 600,
              }}
            >
              {o}
            </div>
          );
        })}
      </div>
    </div>
  );
};
