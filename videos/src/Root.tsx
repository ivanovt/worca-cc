/**
 * Remotion root.
 *
 * Three compositions, one per video in the "How worca works" series:
 *
 *   Video1Intro      Introducing worca           (bullets 1–5)
 *   Video2InsideRun  Inside a worca run          (bullets 6–12)
 *   Video3Workflow   Worca in your workflow      (bullets 13–18)
 *
 * Each composition is just <Chapter chapterNumber={n} /> with the duration
 * derived from word counts in src/lib/script.ts.
 */

import React from "react";
import { Composition } from "remotion";

import "./index.css";
import { Chapter, chapterDurationFrames } from "./compositions/Chapter";
import { theme } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Video1Intro"
        component={Chapter}
        durationInFrames={chapterDurationFrames(1)}
        fps={theme.fps}
        width={theme.width}
        height={theme.height}
        defaultProps={{ chapterNumber: 1 as const }}
      />

      <Composition
        id="Video2InsideRun"
        component={Chapter}
        durationInFrames={chapterDurationFrames(2)}
        fps={theme.fps}
        width={theme.width}
        height={theme.height}
        defaultProps={{ chapterNumber: 2 as const }}
      />

      <Composition
        id="Video3Workflow"
        component={Chapter}
        durationInFrames={chapterDurationFrames(3)}
        fps={theme.fps}
        width={theme.width}
        height={theme.height}
        defaultProps={{ chapterNumber: 3 as const }}
      />
    </>
  );
};
