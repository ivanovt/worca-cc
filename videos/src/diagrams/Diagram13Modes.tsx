/**
 * §13 — Each run lives in its own git worktree (single / fleet / workspace).
 *
 * Visual: three mini diagrams in a row.
 *
 *   SINGLE          FLEET                WORKSPACE
 *   ┌──────┐        prompt → ┌──┐         ┌─────┐
 *   │ Run  │                ├──┤        ┌→│ App │
 *   │      │                ├──┤        │ └─────┘
 *   └──────┘                └──┘        │
 *      ↓                                ┌────┐
 *   1 worktree              N parallel  │ Lib│
 *                           projects    └────┘
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { useReveal } from "./useReveal";
import { Arrow, Node } from "./primitives";
import type { DiagramProps } from "./registry";

const TILE_W = 460;
const TILE_H = 480;
const TILE_GAP = 80;
const TOTAL_W = TILE_W * 3 + TILE_GAP * 2;
const TOTAL_H = TILE_H;

const SINGLE_X = 0;
const FLEET_X = TILE_W + TILE_GAP;
const WORK_X = 2 * (TILE_W + TILE_GAP);

export const Diagram13Modes: React.FC<DiagramProps> = () => {
  const singleReveal = useReveal({ startFrame: 18 });
  const fleetReveal = useReveal({ startFrame: 100 });
  const workReveal = useReveal({ startFrame: 200 });

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      <ModeTile x={SINGLE_X} reveal={singleReveal} title="Single" sub="1 worktree">
        <SingleTile />
      </ModeTile>

      <ModeTile x={FLEET_X} reveal={fleetReveal} title="Fleet" sub="1 prompt → N projects">
        <FleetTile />
      </ModeTile>

      <ModeTile x={WORK_X} reveal={workReveal} title="Workspace" sub="DAG of projects">
        <WorkspaceTile />
      </ModeTile>
    </div>
  );
};

// ── Tile frame ────────────────────────────────────────────────────────────

interface ModeTileProps {
  x: number;
  reveal: { opacity: number; transform: string };
  title: string;
  sub: string;
  children: React.ReactNode;
}

const ModeTile: React.FC<ModeTileProps> = ({ x, reveal, title, sub, children }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: 0,
      width: TILE_W,
      height: TILE_H,
      background: theme.bgCard,
      border: `2px solid ${theme.borderLight}`,
      borderRadius: 14,
      padding: "32px 28px",
      display: "flex",
      flexDirection: "column",
      opacity: reveal.opacity,
      transform: reveal.transform,
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    }}
  >
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize: 14,
        letterSpacing: "0.20em",
        textTransform: "uppercase",
        color: theme.accent,
        marginBottom: 8,
        fontWeight: 600,
      }}
    >
      mode
    </div>
    <div
      style={{
        fontFamily: fonts.body,
        fontSize: 36,
        fontWeight: 700,
        color: theme.text,
        lineHeight: 1.1,
      }}
    >
      {title}
    </div>
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize: 14,
        letterSpacing: "0.10em",
        color: theme.textSecondary,
        marginTop: 6,
      }}
    >
      {sub}
    </div>
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginTop: 20,
      }}
    >
      {children}
    </div>
  </div>
);

// ── Inner illustrations ──────────────────────────────────────────────────

const SingleTile: React.FC = () => (
  <div style={{ position: "relative", width: 220, height: 140 }}>
    <Node label="Project" sublabel="ONE RUN" tint="accent" width={220} height={140} />
  </div>
);

const FleetTile: React.FC = () => {
  // 1 prompt doc on left, 4 project nodes on the right, arrows from doc to each.
  const docX = 0;
  const docY = 110;
  const projX = 200;
  const projW = 130;
  const projH = 56;
  const projYs = [10, 86, 162, 238];
  return (
    <div style={{ position: "relative", width: 340, height: 290 }}>
      {/* Prompt doc */}
      <div
        style={{
          position: "absolute",
          left: docX,
          top: docY,
          width: 140,
          height: 70,
          background: theme.bgPrimary,
          border: `2px solid ${theme.accent}`,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: fonts.mono,
          fontSize: 16,
          letterSpacing: "0.10em",
          color: theme.accent,
          textTransform: "uppercase",
        }}
      >
        prompt
      </div>
      {/* Fanout arrows */}
      {projYs.map((y, i) => (
        <Arrow
          key={`f-${i}`}
          from={[docX + 144, docY + 35]}
          to={[projX - 4, y + projH / 2]}
          color={theme.accent}
          dashFlow={0.7}
          elapsed={60}
          strokeWidth={2}
        />
      ))}
      {/* Project boxes */}
      {projYs.map((y, i) => (
        <div
          key={`p-${i}`}
          style={{
            position: "absolute",
            left: projX,
            top: y,
            width: projW,
            height: projH,
            background: theme.bgPrimary,
            border: `1.5px solid ${theme.borderLight}`,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: fonts.body,
            fontSize: 16,
            fontWeight: 500,
            color: theme.text,
          }}
        >
          Project {String.fromCharCode(65 + i)}
        </div>
      ))}
    </div>
  );
};

const WorkspaceTile: React.FC = () => {
  // 4 projects in a DAG: lib at top, ui in middle, app at bottom; lib → ui, lib → app, ui → app.
  const nodes: Array<{ x: number; y: number; label: string }> = [
    { x: 110, y: 0, label: "Lib" },
    { x: 20, y: 110, label: "UI" },
    { x: 200, y: 110, label: "API" },
    { x: 110, y: 220, label: "App" },
  ];
  const edges: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
  ];
  const nodeW = 100;
  const nodeH = 60;
  return (
    <div style={{ position: "relative", width: 320, height: 290 }}>
      {edges.map(([a, b], i) => {
        const from = nodes[a];
        const to = nodes[b];
        return (
          <Arrow
            key={`e-${i}`}
            from={[from.x + nodeW / 2, from.y + nodeH]}
            to={[to.x + nodeW / 2, to.y]}
            color={theme.accent}
            dashFlow={0.5}
            elapsed={60}
            strokeWidth={2}
          />
        );
      })}
      {nodes.map((n) => (
        <div
          key={n.label}
          style={{
            position: "absolute",
            left: n.x,
            top: n.y,
            width: nodeW,
            height: nodeH,
            background: theme.bgPrimary,
            border: `1.5px solid ${theme.accent}`,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: fonts.body,
            fontSize: 16,
            fontWeight: 600,
            color: theme.text,
          }}
        >
          {n.label}
        </div>
      ))}
    </div>
  );
};
