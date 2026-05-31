/**
 * §15 — Built-in templates, and your own.
 *
 * Visual: a 2x2 grid of template cards. Each card shows the template
 * name, a brief description, and the stage chips that template enables.
 * The fourth ("Custom") card has accent styling.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

interface Template {
  name: string;
  description: string;
  stages: string[];
  custom?: boolean;
}

const TEMPLATES: Template[] = [
  {
    name: "Feature",
    description: "Full pipeline with planning, review, and testing",
    stages: ["Plan", "Coord", "Impl", "Test", "Review", "PR"],
  },
  {
    name: "Bug fix",
    description: "Skip planning, jump to implement",
    stages: ["Impl", "Test", "Review", "PR"],
  },
  {
    name: "Docs only",
    description: "No implementer-tester loop",
    stages: ["Plan", "Docs", "PR"],
  },
  {
    name: "Custom",
    description: "Write your own template",
    stages: ["+", "your", "stages"],
    custom: true,
  },
];

const CARD_W = 580;
const CARD_H = 240;
const GAP = 28;
const TOTAL_W = CARD_W * 2 + GAP;
const TOTAL_H = CARD_H * 2 + GAP;

export const Diagram15Templates: React.FC<DiagramProps> = () => {
  const FIRST = 20;
  const STRIDE = 60;
  const reveals = TEMPLATES.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {TEMPLATES.map((t, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        return (
          <div
            key={t.name}
            style={{
              position: "absolute",
              left: col * (CARD_W + GAP),
              top: row * (CARD_H + GAP),
              width: CARD_W,
              height: CARD_H,
              background: theme.bgCard,
              border: `2px solid ${t.custom ? theme.accent : theme.borderLight}`,
              borderRadius: 14,
              padding: "26px 30px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              opacity: reveals[i].opacity,
              transform: reveals[i].transform,
              boxShadow: t.custom
                ? `0 0 24px ${theme.accentDim}, 0 8px 24px rgba(0,0,0,0.4)`
                : "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: 32,
                  fontWeight: 700,
                  color: t.custom ? theme.accent : theme.text,
                  lineHeight: 1.1,
                }}
              >
                {t.name}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: theme.textMuted,
                }}
              >
                {t.custom ? "yours" : "built-in"}
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
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {t.stages.map((s) => (
                <div
                  key={s}
                  style={{
                    padding: "6px 12px",
                    background: t.custom ? "transparent" : theme.bgPrimary,
                    border: `1.5px solid ${t.custom ? theme.accent : theme.borderLight}`,
                    borderRadius: 6,
                    fontFamily: fonts.mono,
                    fontSize: 13,
                    letterSpacing: "0.06em",
                    color: t.custom ? theme.accent : theme.text,
                    fontWeight: 600,
                    textTransform: "uppercase",
                  }}
                >
                  {s}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
