/**
 * Diagram primitives — Node, Arrow, DocIcon.
 *
 * Visual language matches the worca.dev marketing site: dark navy cards
 * (#0c1525) with a subtle border, mint accents (#00e5a0) for flow and
 * highlights, generous radius, rare hard edges. Per-model tints (Opus
 * purple, Sonnet blue) are exposed for the pipeline diagram.
 *
 * All primitives accept a `style` prop so the caller can apply useReveal()
 * output for entry animation. They use SVG where shape control matters
 * (DocIcon, Arrow), HTML where text layout matters (Node).
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";

// ─── Node ─────────────────────────────────────────────────────────────────

export type NodeTint = "default" | "accent" | "opus" | "sonnet" | "muted";

const NODE_TINT: Record<NodeTint, { border: string; glow: string; label: string }> = {
  default: { border: theme.borderLight, glow: "transparent", label: theme.text },
  accent: {
    border: theme.accent,
    glow: theme.accentDim,
    label: theme.text,
  },
  opus: { border: theme.opus, glow: theme.opusDim, label: theme.opus },
  sonnet: {
    border: theme.sonnet,
    glow: theme.sonnetDim,
    label: theme.sonnet,
  },
  muted: { border: theme.border, glow: "transparent", label: theme.textSecondary },
};

interface NodeProps {
  label: string;
  /** Smaller line under the main label (e.g. agent role). */
  sublabel?: string;
  tint?: NodeTint;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}

export const Node: React.FC<NodeProps> = ({
  label,
  sublabel,
  tint = "default",
  width = 260,
  height = 140,
  style,
}) => {
  const t = NODE_TINT[tint];
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: theme.bgCard,
        border: `2px solid ${t.border}`,
        borderRadius: 12,
        boxShadow:
          t.glow === "transparent"
            ? "0 8px 24px rgba(0,0,0,0.35)"
            : `0 0 0 1px ${t.border}, 0 0 28px ${t.glow}, 0 8px 24px rgba(0,0,0,0.35)`,
        padding: "20px 28px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 6,
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: fonts.body,
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: t.label,
          lineHeight: 1.15,
        }}
      >
        {label}
      </div>
      {sublabel ? (
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 16,
            letterSpacing: "0.12em",
            color: theme.textSecondary,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          {sublabel}
        </div>
      ) : null}
    </div>
  );
};

// ─── Arrow (SVG with optional animated dash flow) ─────────────────────────

interface ArrowProps {
  /** Start point (x,y) in the parent's coordinate system. */
  from: [number, number];
  /** End point (x,y). */
  to: [number, number];
  color?: string;
  /** When > 0, dashes flow from start to end at this many px per frame.
   *  Use 0 for a solid line. */
  dashFlow?: number;
  /** Current frame — caller passes useCurrentFrame() so the dash phase
   *  advances. The dash flow is gated by `elapsed` ≥ 0 (caller can pass
   *  the elapsed-since-reveal frames to delay the start). */
  elapsed?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

export const Arrow: React.FC<ArrowProps> = ({
  from,
  to,
  color = theme.accent,
  dashFlow = 0,
  elapsed = 0,
  strokeWidth = 3,
  style,
}) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const minX = Math.min(x1, x2) - 20;
  const minY = Math.min(y1, y2) - 20;
  const maxX = Math.max(x1, x2) + 20;
  const maxY = Math.max(y1, y2) + 20;
  const width = maxX - minX;
  const height = maxY - minY;

  const dashOffset = dashFlow > 0 ? -elapsed * dashFlow : 0;
  const dasharray = dashFlow > 0 ? "14 10" : undefined;

  // ID needs to be stable per render but unique enough across arrows; tying
  // it to the endpoint coordinates is good enough for our static diagrams.
  const markerId = `arrow-head-${x1}-${y1}-${x2}-${y2}`.replace(/\./g, "_");

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: "absolute",
        left: minX,
        top: minY,
        overflow: "visible",
        ...style,
      }}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={color} />
        </marker>
      </defs>
      <line
        x1={x1 - minX}
        y1={y1 - minY}
        x2={x2 - minX}
        y2={y2 - minY}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={dasharray}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
};

// ─── DocIcon (paper sheet with folded corner) ─────────────────────────────

interface DocIconProps {
  size?: number;
  color?: string;
  /** Label shown inside the icon, e.g. "RFC" or "MD". */
  label?: string;
  /** Show a small "lock" or "stamp" badge on the corner. */
  stamp?: string;
  style?: React.CSSProperties;
}

export const DocIcon: React.FC<DocIconProps> = ({
  size = 100,
  color = theme.text,
  label,
  stamp,
  style,
}) => {
  const w = size * 0.78;
  const h = size;
  const fold = size * 0.22;
  return (
    <div style={{ position: "relative", width: w, height: h, ...style }}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ position: "absolute", inset: 0 }}
      >
        {/* paper shape */}
        <path
          d={`
            M 0 0
            L ${w - fold} 0
            L ${w} ${fold}
            L ${w} ${h}
            L 0 ${h}
            Z
          `}
          fill={theme.bgCard}
          stroke={color}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
        {/* corner fold */}
        <path
          d={`M ${w - fold} 0 L ${w - fold} ${fold} L ${w} ${fold}`}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
        {/* text lines */}
        <line
          x1={w * 0.15}
          y1={h * 0.45}
          x2={w * 0.7}
          y2={h * 0.45}
          stroke={color}
          strokeWidth={2}
          opacity={0.45}
          strokeLinecap="round"
        />
        <line
          x1={w * 0.15}
          y1={h * 0.58}
          x2={w * 0.8}
          y2={h * 0.58}
          stroke={color}
          strokeWidth={2}
          opacity={0.45}
          strokeLinecap="round"
        />
        <line
          x1={w * 0.15}
          y1={h * 0.71}
          x2={w * 0.55}
          y2={h * 0.71}
          stroke={color}
          strokeWidth={2}
          opacity={0.45}
          strokeLinecap="round"
        />
      </svg>
      {label ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: h * 0.22,
            textAlign: "center",
            fontFamily: fonts.mono,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "0.10em",
            color,
          }}
        >
          {label}
        </div>
      ) : null}
      {stamp ? (
        <div
          style={{
            position: "absolute",
            top: -10,
            right: -10,
            background: theme.accent,
            color: theme.bgDeep,
            fontFamily: fonts.mono,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.08em",
            padding: "4px 10px",
            borderRadius: 6,
            textTransform: "uppercase",
            boxShadow: `0 0 16px ${theme.accentDim}`,
          }}
        >
          {stamp}
        </div>
      ) : null}
    </div>
  );
};
