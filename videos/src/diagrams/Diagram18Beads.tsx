/**
 * §18 — Strategic context persists across sessions.
 *
 * Visual: a horizontal timeline with sessions as vertical bars. Bead
 * nodes appear on the timeline and span sessions, connected by lines —
 * the strategic state survives a session boundary.
 *
 *   Session 1 │ Session 2 │ Session 3 │ Session 4
 *             │           │           │
 *   ● ────────●───────────●──────────●   bead: auth refactor
 *             ● ──────────●──────────●   bead: test infra
 *                                    ● ─ bead: discovered fix
 *
 *   (persisted via git)
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const SESSIONS = ["Session 1", "Session 2", "Session 3", "Session 4"];

interface Bead {
  label: string;
  from: number;
  to: number;
  /** Index in the row stack — controls vertical position. */
  row: number;
  /** When the bead was "discovered" — for narrative timing only, not used by SVG. */
  discovered?: boolean;
}

const BEADS: Bead[] = [
  { label: "auth-refactor", from: 0, to: 3, row: 0 },
  { label: "test-infra", from: 1, to: 3, row: 1 },
  { label: "discovered-fix", from: 2, to: 3, row: 2, discovered: true },
];

const SESSION_W = 220;
const SESSION_GAP = 60;
const TIMELINE_TOP = 0;
const TIMELINE_H = 80;
const ROW_H = 70;
const ROW_TOP = TIMELINE_TOP + TIMELINE_H + 60;
const BEAD_R = 14;

const TOTAL_W = SESSIONS.length * SESSION_W + (SESSIONS.length - 1) * SESSION_GAP;
const TOTAL_H = ROW_TOP + BEADS.length * ROW_H + 100;

export const Diagram18Beads: React.FC<DiagramProps> = () => {
  // Timeline reveals first
  const timelineReveal = useReveal({ startFrame: 14 });
  const sessionReveals = SESSIONS.map((_, i) =>
    useReveal({ startFrame: 28 + i * 18 }),
  );
  const beadReveals = BEADS.map((_, i) =>
    useReveal({ startFrame: 110 + i * 60 }),
  );
  const gitTagReveal = useReveal({ startFrame: 280 });

  const sessionX = (i: number) => i * (SESSION_W + SESSION_GAP);
  const sessionCenterX = (i: number) => sessionX(i) + SESSION_W / 2;

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Timeline base line */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: TIMELINE_TOP + TIMELINE_H - 2,
          width: TOTAL_W,
          height: 2,
          background: theme.borderLight,
          opacity: timelineReveal.opacity,
        }}
      />

      {/* Session labels and dividers */}
      {SESSIONS.map((s, i) => (
        <React.Fragment key={s}>
          {/* Vertical divider */}
          <div
            style={{
              position: "absolute",
              left: sessionCenterX(i),
              top: TIMELINE_TOP + TIMELINE_H,
              width: 1,
              height: TOTAL_H - TIMELINE_TOP - TIMELINE_H - 60,
              background: theme.border,
              opacity: sessionReveals[i].opacity * 0.6,
            }}
          />
          {/* Session label */}
          <div
            style={{
              position: "absolute",
              left: sessionX(i),
              top: TIMELINE_TOP,
              width: SESSION_W,
              height: TIMELINE_H,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              opacity: sessionReveals[i].opacity,
              transform: sessionReveals[i].transform,
            }}
          >
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                letterSpacing: "0.20em",
                textTransform: "uppercase",
                color: theme.textSecondary,
              }}
            >
              {s}
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 11,
                letterSpacing: "0.12em",
                color: theme.textMuted,
                marginTop: 4,
              }}
            >
              agent · #{i + 1}
            </div>
          </div>
        </React.Fragment>
      ))}

      {/* Beads — one row per bead */}
      {BEADS.map((b, i) => {
        const rowY = ROW_TOP + b.row * ROW_H;
        const xStart = sessionCenterX(b.from);
        const xEnd = sessionCenterX(b.to);
        return (
          <div
            key={b.label}
            style={{
              position: "absolute",
              left: 0,
              top: rowY,
              width: TOTAL_W,
              height: ROW_H,
              opacity: beadReveals[i].opacity,
              transform: beadReveals[i].transform,
            }}
          >
            {/* Connecting line between bead endpoints */}
            <div
              style={{
                position: "absolute",
                left: xStart,
                top: ROW_H / 2 - 2,
                width: xEnd - xStart,
                height: 4,
                background: b.discovered ? theme.opus : theme.accent,
                borderRadius: 2,
                boxShadow: `0 0 12px ${b.discovered ? theme.opusDim : theme.accentDim}`,
              }}
            />
            {/* Bead nodes at each session the bead exists in */}
            {SESSIONS.map((_, sIdx) => {
              if (sIdx < b.from || sIdx > b.to) return null;
              return (
                <div
                  key={sIdx}
                  style={{
                    position: "absolute",
                    left: sessionCenterX(sIdx) - BEAD_R,
                    top: ROW_H / 2 - BEAD_R,
                    width: BEAD_R * 2,
                    height: BEAD_R * 2,
                    borderRadius: "50%",
                    background: b.discovered ? theme.opus : theme.accent,
                    border: `2px solid ${theme.bgDeep}`,
                    boxShadow: `0 0 14px ${b.discovered ? theme.opus : theme.accent}`,
                  }}
                />
              );
            })}
            {/* Bead label */}
            <div
              style={{
                position: "absolute",
                left: TOTAL_W + 20,
                top: ROW_H / 2 - 12,
                fontFamily: fonts.mono,
                fontSize: 15,
                letterSpacing: "0.08em",
                color: theme.text,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: b.discovered ? theme.opus : theme.accent }}>●</span>{" "}
              {b.label}
              {b.discovered ? (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: theme.textMuted,
                  }}
                >
                  discovered
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* "persisted via git" tag at the bottom */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: TOTAL_W,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: theme.textSecondary,
          opacity: gitTagReveal.opacity,
          transform: gitTagReveal.transform,
        }}
      >
        persisted via git — every session sees the same beads
      </div>
    </div>
  );
};
