/**
 * §2 — Every step runs in a dedicated agent with fresh context.
 *
 * Visual: three agent cards in a row, each with a small "context scope"
 * sub-card below showing only the artifact that agent receives. The cards
 * appear with their scope, conveying isolation — nothing leaks between
 * them.
 *
 *   [Planner]      [Implementer]   [Reviewer]
 *    │              │                │
 *  ┌─┴─────┐      ┌─┴───────────┐  ┌─┴──────────┐
 *  │request│      │design for   │  │ diff to    │
 *  │       │      │one slice    │  │ review     │
 *  └───────┘      └─────────────┘  └────────────┘
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const AGENTS = [
  { agent: "Planner", scope: "The request" },
  { agent: "Implementer", scope: "Design for one slice" },
  { agent: "Reviewer", scope: "The diff to review" },
] as const;

const NODE_W = 280;
const NODE_H = 130;
const SCOPE_W = 280;
const SCOPE_H = 110;
const COL_GAP = 80;
const CONNECTOR_H = 40;
const TOTAL_W = NODE_W * AGENTS.length + COL_GAP * (AGENTS.length - 1);
const TOTAL_H = NODE_H + CONNECTOR_H + SCOPE_H;

export const Diagram02Context: React.FC<DiagramProps> = () => {
  const FIRST = 28;
  const STRIDE = 70;

  const agentReveals = AGENTS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE }),
  );
  const scopeReveals = AGENTS.map((_, i) =>
    useReveal({ startFrame: FIRST + i * STRIDE + 18 }),
  );

  const colLeft = (i: number) => i * (NODE_W + COL_GAP);

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {AGENTS.map((a, i) => {
        const x = colLeft(i);
        return (
          <React.Fragment key={a.agent}>
            {/* Agent node */}
            <div
              style={{
                position: "absolute",
                left: x,
                top: 0,
                opacity: agentReveals[i].opacity,
                transform: agentReveals[i].transform,
              }}
            >
              <Node
                label={a.agent}
                sublabel="AGENT"
                tint="default"
                width={NODE_W}
                height={NODE_H}
              />
            </div>

            {/* Connector line down to scope */}
            <div
              style={{
                position: "absolute",
                left: x + NODE_W / 2 - 1,
                top: NODE_H,
                width: 2,
                height: CONNECTOR_H,
                background: theme.borderLight,
                opacity: agentReveals[i].opacity,
              }}
            />

            {/* Context scope card */}
            <div
              style={{
                position: "absolute",
                left: x + (NODE_W - SCOPE_W) / 2,
                top: NODE_H + CONNECTOR_H,
                width: SCOPE_W,
                height: SCOPE_H,
                background: theme.bgPrimary,
                border: `1.5px dashed ${theme.accent}`,
                borderRadius: 10,
                padding: "18px 22px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
                opacity: scopeReveals[i].opacity,
                transform: scopeReveals[i].transform,
              }}
            >
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: theme.accent,
                  fontWeight: 600,
                }}
              >
                only sees
              </div>
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: 24,
                  fontWeight: 500,
                  color: theme.text,
                  lineHeight: 1.2,
                }}
              >
                {a.scope}
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
