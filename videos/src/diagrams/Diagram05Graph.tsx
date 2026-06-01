/**
 * §5 — Code orientation through a knowledge graph.
 *
 * Visual: source code on the left feeds (via two engine badges) into a
 * structural knowledge graph (nodes + edges). On the right, an agent
 * queries the graph instead of grepping.
 *
 *   ┌────────┐                                ┌──────┐
 *   │  src/  │ ──┐    ●───●───●               │Agent │
 *   │  *.ts  │   │    │ \ │ / │   ◄────────── │      │
 *   └────────┘   ├─►  ●───●───●     query     └──────┘
 *               graphify · Code Review Graph
 */

import React from "react";
import { useCurrentFrame } from "remotion";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Arrow, DocIcon, Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

// Graph node positions (relative to graph center)
const GRAPH_NODES: Array<{ x: number; y: number; label: string }> = [
  { x: -120, y: -50, label: "auth" },
  { x: 0, y: -90, label: "api" },
  { x: 120, y: -50, label: "db" },
  { x: -90, y: 60, label: "utils" },
  { x: 30, y: 90, label: "core" },
  { x: 130, y: 50, label: "ui" },
];

// Edge list as pairs of indices into GRAPH_NODES
const GRAPH_EDGES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [0, 4],
  [1, 4],
  [2, 5],
  [3, 4],
  [4, 5],
  [3, 0],
];

const SRC_W = 180;
const SRC_H = 200;
const GRAPH_W = 380;
const GRAPH_H = 280;
const AGENT_W = 200;
const AGENT_H = 130;

const SRC_X = 0;
const GRAPH_X = SRC_X + SRC_W + 110;
const AGENT_X = GRAPH_X + GRAPH_W + 110;
const TOTAL_W = AGENT_X + AGENT_W;
const TOTAL_H = GRAPH_H + 90; // graph height + label below

const GRAPH_CENTER_Y = GRAPH_H / 2;
const SRC_CENTER_Y = GRAPH_CENTER_Y;
const AGENT_CENTER_Y = GRAPH_CENTER_Y;

export const Diagram05Graph: React.FC<DiagramProps> = () => {
  const frame = useCurrentFrame();

  // Reveal cadence: source first, then the graph, then engines, then agent
  // and the query arrow.
  const srcReveal = useReveal({ startFrame: 18 });
  const buildArrowReveal = useReveal({ startFrame: 42 });
  const enginesReveal = useReveal({ startFrame: 70 });
  const graphAppearStart = 90;
  // edges fade in one-by-one
  const edgeOpacity = (i: number) => {
    const start = graphAppearStart + i * 4;
    const end = start + 14;
    return frame >= start
      ? Math.min(1, (frame - start) / (end - start))
      : 0;
  };
  // nodes pop in
  const nodeOpacity = (i: number) => {
    const start = graphAppearStart + i * 6 + 4;
    const end = start + 14;
    return frame >= start
      ? Math.min(1, (frame - start) / (end - start))
      : 0;
  };

  const agentReveal = useReveal({ startFrame: graphAppearStart + GRAPH_NODES.length * 6 + 20 });

  // Query arrow (right → left, from agent to graph)
  const queryStart = graphAppearStart + GRAPH_NODES.length * 6 + 40;
  const elapsedQuery = Math.max(0, frame - queryStart);

  // Build arrow (left → right, from src to graph)
  const buildStart = 42;
  const elapsedBuild = Math.max(0, frame - buildStart);

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Source code card */}
      <div
        style={{
          position: "absolute",
          left: SRC_X,
          top: SRC_CENTER_Y - SRC_H / 2,
          width: SRC_W,
          height: SRC_H,
          background: theme.bgCard,
          border: `2px solid ${theme.borderLight}`,
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          opacity: srcReveal.opacity,
          transform: srcReveal.transform,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}
      >
        <DocIcon size={80} color={theme.text} label="TS" />
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 14,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.textSecondary,
          }}
        >
          source code
        </div>
      </div>

      {/* "build" arrow: source → graph */}
      <Arrow
        from={[SRC_X + SRC_W + 8, SRC_CENTER_Y]}
        to={[GRAPH_X - 8, GRAPH_CENTER_Y]}
        color={theme.textSecondary}
        dashFlow={0.6}
        elapsed={elapsedBuild}
        strokeWidth={2.5}
        style={{ opacity: buildArrowReveal.opacity }}
      />

      {/* Engine labels below the build arrow */}
      <div
        style={{
          position: "absolute",
          left: SRC_X + SRC_W + 20,
          top: SRC_CENTER_Y + 40,
          width: GRAPH_X - SRC_X - SRC_W - 28,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontSize: 13,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: theme.accent,
          opacity: enginesReveal.opacity,
          transform: enginesReveal.transform,
          lineHeight: 1.6,
        }}
      >
        graphify
        <br />
        code review graph
      </div>

      {/* Graph SVG */}
      <svg
        width={GRAPH_W}
        height={GRAPH_H}
        viewBox={`-${GRAPH_W / 2} -${GRAPH_H / 2} ${GRAPH_W} ${GRAPH_H}`}
        style={{
          position: "absolute",
          left: GRAPH_X,
          top: 0,
          overflow: "visible",
        }}
      >
        {/* Edges */}
        {GRAPH_EDGES.map(([a, b], i) => {
          const A = GRAPH_NODES[a];
          const B = GRAPH_NODES[b];
          return (
            <line
              key={`e-${i}`}
              x1={A.x}
              y1={A.y}
              x2={B.x}
              y2={B.y}
              stroke={theme.borderLight}
              strokeWidth={1.5}
              opacity={edgeOpacity(i) * 0.7}
            />
          );
        })}
        {/* Nodes */}
        {GRAPH_NODES.map((n, i) => (
          <g key={`n-${i}`} opacity={nodeOpacity(i)}>
            <circle
              cx={n.x}
              cy={n.y}
              r={11}
              fill={theme.accent}
              style={{ filter: `drop-shadow(0 0 10px ${theme.accent})` }}
            />
            <text
              x={n.x}
              y={n.y + 30}
              textAnchor="middle"
              fill={theme.text}
              fontFamily={fonts.mono}
              fontSize={13}
              fontWeight={500}
              letterSpacing="0.08em"
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>

      {/* "knowledge graph" caption */}
      <div
        style={{
          position: "absolute",
          left: GRAPH_X,
          top: GRAPH_H + 14,
          width: GRAPH_W,
          textAlign: "center",
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: theme.textSecondary,
          opacity: enginesReveal.opacity,
        }}
      >
        knowledge graph
      </div>

      {/* Query arrow: agent → graph (right to left) */}
      <Arrow
        from={[AGENT_X - 8, AGENT_CENTER_Y]}
        to={[GRAPH_X + GRAPH_W + 8, GRAPH_CENTER_Y]}
        color={theme.accent}
        dashFlow={0.8}
        elapsed={elapsedQuery}
        strokeWidth={2.5}
        style={{ opacity: elapsedQuery > 0 ? 1 : 0 }}
      />
      <div
        style={{
          position: "absolute",
          left: GRAPH_X + GRAPH_W + 8,
          top: AGENT_CENTER_Y + 26,
          fontFamily: fonts.mono,
          fontSize: 13,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: theme.accent,
          opacity: elapsedQuery > 0 ? 1 : 0,
        }}
      >
        query
      </div>

      {/* Agent card */}
      <div
        style={{
          position: "absolute",
          left: AGENT_X,
          top: AGENT_CENTER_Y - AGENT_H / 2,
          opacity: agentReveal.opacity,
          transform: agentReveal.transform,
        }}
      >
        <Node
          label="Agent"
          sublabel="QUERIES"
          tint="default"
          width={AGENT_W}
          height={AGENT_H}
        />
      </div>
    </div>
  );
};
