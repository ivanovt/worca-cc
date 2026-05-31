/**
 * §16 — Events out, control in.
 *
 * Visual: a worca pipeline node in the center, with multiple OUT arrows
 * flowing to subscribers (webhook icon, chat icon) and a single IN arrow
 * from a "control webhook" back to the pipeline. Event types pop up as
 * small chips around the pipeline node.
 */

import React from "react";

import { theme } from "../theme";
import { fonts } from "../fonts";
import { Arrow, Node } from "./primitives";
import { useReveal } from "./useReveal";
import type { DiagramProps } from "./registry";

const EVENT_CHIPS = [
  "stage.started",
  "bead.completed",
  "test.passed",
  "cost.tick",
];

const SUBS = [
  { label: "Webhook", sub: "HMAC-signed" },
  { label: "Chat", sub: "Telegram / Discord / Slack" },
];

const PIPELINE_W = 280;
const PIPELINE_H = 160;
const SUB_W = 270;
const SUB_H = 90;
const CONTROL_W = 260;
const CONTROL_H = 90;

const TOTAL_W = 1280;
const TOTAL_H = 500;

const PIPELINE_X = (TOTAL_W - PIPELINE_W) / 2;
const PIPELINE_Y = (TOTAL_H - PIPELINE_H) / 2;
const PIPELINE_CENTER_X = PIPELINE_X + PIPELINE_W / 2;
const PIPELINE_CENTER_Y = PIPELINE_Y + PIPELINE_H / 2;

const SUB_X = TOTAL_W - SUB_W;
const CONTROL_X = 0;

export const Diagram16Events: React.FC<DiagramProps> = () => {
  const pipelineReveal = useReveal({ startFrame: 14 });

  const chipReveals = EVENT_CHIPS.map((_, i) =>
    useReveal({ startFrame: 50 + i * 18 }),
  );

  const subReveals = SUBS.map((_, i) =>
    useReveal({ startFrame: 140 + i * 28 }),
  );
  const controlReveal = useReveal({ startFrame: 240 });

  return (
    <div style={{ position: "relative", width: TOTAL_W, height: TOTAL_H }}>
      {/* Pipeline center */}
      <div
        style={{
          position: "absolute",
          left: PIPELINE_X,
          top: PIPELINE_Y,
          opacity: pipelineReveal.opacity,
          transform: pipelineReveal.transform,
        }}
      >
        <Node
          label="worca pipeline"
          sublabel="~80 EVENT TYPES"
          tint="accent"
          width={PIPELINE_W}
          height={PIPELINE_H}
        />
      </div>

      {/* Event chips emerging from around the pipeline */}
      {EVENT_CHIPS.map((chip, i) => {
        const angle = (i / EVENT_CHIPS.length) * Math.PI - Math.PI / 2;
        const r = 180;
        const x = PIPELINE_CENTER_X + Math.cos(angle) * r - 90;
        const y = PIPELINE_CENTER_Y + Math.sin(angle) * r * 0.55 - 18;
        return (
          <div
            key={chip}
            style={{
              position: "absolute",
              left: x,
              top: y,
              padding: "6px 12px",
              background: theme.bgPrimary,
              border: `1.5px solid ${theme.borderLight}`,
              borderRadius: 6,
              fontFamily: fonts.mono,
              fontSize: 14,
              letterSpacing: "0.05em",
              color: theme.textSecondary,
              opacity: chipReveals[i].opacity,
              transform: chipReveals[i].transform,
            }}
          >
            {chip}
          </div>
        );
      })}

      {/* OUT arrows: pipeline → subscribers */}
      {SUBS.map((_, i) => {
        const y = PIPELINE_CENTER_Y + (i - (SUBS.length - 1) / 2) * 80;
        return (
          <Arrow
            key={`o-${i}`}
            from={[PIPELINE_X + PIPELINE_W + 8, PIPELINE_CENTER_Y]}
            to={[SUB_X - 8, y]}
            color={theme.accent}
            dashFlow={0.7}
            elapsed={60}
            strokeWidth={2.5}
            style={{ opacity: subReveals[i].opacity }}
          />
        );
      })}

      {/* "events" label above the OUT arrows */}
      <div
        style={{
          position: "absolute",
          left: PIPELINE_X + PIPELINE_W + 60,
          top: PIPELINE_CENTER_Y - 90,
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.20em",
          textTransform: "uppercase",
          color: theme.accent,
          opacity: subReveals[0].opacity,
        }}
      >
        events out
      </div>

      {/* Subscriber boxes on the right */}
      {SUBS.map((s, i) => {
        const y = PIPELINE_CENTER_Y + (i - (SUBS.length - 1) / 2) * 80 - SUB_H / 2;
        return (
          <div
            key={s.label}
            style={{
              position: "absolute",
              left: SUB_X,
              top: y,
              width: SUB_W,
              height: SUB_H,
              background: theme.bgCard,
              border: `2px solid ${theme.borderLight}`,
              borderRadius: 10,
              padding: "12px 18px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              opacity: subReveals[i].opacity,
              transform: subReveals[i].transform,
            }}
          >
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 22,
                fontWeight: 600,
                color: theme.text,
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 12,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: theme.textSecondary,
                marginTop: 4,
              }}
            >
              {s.sub}
            </div>
          </div>
        );
      })}

      {/* IN arrow: control → pipeline */}
      <Arrow
        from={[CONTROL_X + CONTROL_W + 8, PIPELINE_CENTER_Y]}
        to={[PIPELINE_X - 8, PIPELINE_CENTER_Y]}
        color={theme.opus}
        dashFlow={0.7}
        elapsed={60}
        strokeWidth={2.5}
        style={{ opacity: controlReveal.opacity }}
      />

      {/* "control" label above the IN arrow */}
      <div
        style={{
          position: "absolute",
          left: CONTROL_W + 30,
          top: PIPELINE_CENTER_Y - 40,
          fontFamily: fonts.mono,
          fontSize: 14,
          letterSpacing: "0.20em",
          textTransform: "uppercase",
          color: theme.opus,
          opacity: controlReveal.opacity,
        }}
      >
        control in
      </div>

      {/* Control webhook source on the left */}
      <div
        style={{
          position: "absolute",
          left: CONTROL_X,
          top: PIPELINE_CENTER_Y - CONTROL_H / 2,
          width: CONTROL_W,
          height: CONTROL_H,
          background: theme.bgCard,
          border: `2px solid ${theme.opus}`,
          borderRadius: 10,
          padding: "12px 18px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          opacity: controlReveal.opacity,
          transform: controlReveal.transform,
          boxShadow: `0 0 18px ${theme.opusDim}`,
        }}
      >
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: 22,
            fontWeight: 600,
            color: theme.text,
          }}
        >
          Control webhook
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 12,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: theme.opus,
            marginTop: 4,
          }}
        >
          pause · resume · stop
        </div>
      </div>
    </div>
  );
};
