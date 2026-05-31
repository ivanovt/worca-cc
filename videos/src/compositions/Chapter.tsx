/**
 * Chapter — generic composition that turns a Chapter (intro card + N bullet
 * scenes + outro card) into a sequenced Remotion timeline. All three videos
 * use this exact component, parameterised by `chapterNumber`.
 *
 * Scene durations come from script.ts word counts via lib/timing.ts. So
 * tweaking a bullet's body text re-times the composition automatically.
 */

import React from "react";
import { AbsoluteFill, Sequence } from "remotion";

import { ChapterCard } from "../scenes/ChapterCard";
import { BulletScene } from "../scenes/BulletScene";
import { chapters } from "../lib/script";
import { chapterCardFrames, sceneFramesForWords } from "../lib/timing";

export interface ChapterProps {
  // Optional with a default so the type matches Remotion's loose
  // Record<string, unknown> expectation on <Composition component={…} />.
  // Each <Composition /> in Root.tsx pins the real value via defaultProps.
  chapterNumber?: 1 | 2 | 3;
}

export const Chapter: React.FC<ChapterProps> = ({ chapterNumber = 1 }) => {
  const chapter = chapters[chapterNumber];
  const intro = chapterCardFrames();
  const outro = chapterCardFrames();

  let cursor = intro;
  const sceneSequences = chapter.scenes.map((scene, idx) => {
    const frames = sceneFramesForWords(scene.words);
    const from = cursor;
    cursor += frames;
    const label = `${String(scene.id).padStart(2, "0")} / 18`;
    return (
      <Sequence
        key={scene.id}
        from={from}
        durationInFrames={frames}
        layout="none"
        name={`#${scene.id} — ${scene.title.slice(0, 40)}`}
      >
        <BulletScene scene={scene} sceneLabel={label} />
      </Sequence>
    );
  });

  return (
    <AbsoluteFill>
      <Sequence
        from={0}
        durationInFrames={intro}
        layout="none"
        name={`Intro — Video ${chapterNumber}`}
      >
        <ChapterCard
          chapterNumber={chapterNumber}
          chapterTitle={chapter.title}
          variant="intro"
        />
      </Sequence>

      {sceneSequences}

      <Sequence
        from={cursor}
        durationInFrames={outro}
        layout="none"
        name={`Outro — Video ${chapterNumber}`}
      >
        <ChapterCard
          chapterNumber={chapterNumber}
          chapterTitle={chapter.title}
          variant="outro"
        />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Total length of a chapter in frames — used by Root.tsx calculateMetadata. */
export const chapterDurationFrames = (chapterNumber: 1 | 2 | 3): number => {
  const chapter = chapters[chapterNumber];
  const sum = chapter.scenes.reduce(
    (acc, s) => acc + sceneFramesForWords(s.words),
    0,
  );
  return chapterCardFrames() + sum + chapterCardFrames();
};
