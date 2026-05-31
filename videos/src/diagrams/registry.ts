/**
 * Diagram registry — maps bullet ID (1..18) to the React component that
 * renders that bullet's diagram.
 *
 * Bullets without a bespoke diagram yet fall through to
 * DiagramPlaceholder. The intent is for this map to grow one entry at a
 * time as we author diagrams — no other code needs to change.
 */

import type React from "react";

import { DiagramPlaceholder } from "./DiagramPlaceholder";
import { Diagram01Orchestrator } from "./Diagram01Orchestrator";
import { Diagram04Inputs } from "./Diagram04Inputs";
import { Diagram06Pipeline } from "./Diagram06Pipeline";

export interface DiagramProps {
  /** Word count of the bullet — diagrams use this to pace their reveal
   *  so element timing tracks the narration window. */
  words: number;
}

const REGISTRY: Partial<Record<number, React.FC<DiagramProps>>> = {
  1: Diagram01Orchestrator,
  4: Diagram04Inputs,
  6: Diagram06Pipeline,
  // 2, 3, 5, 7..18 — placeholder until bespoke diagrams are authored
};

export const diagramFor = (bulletId: number): React.FC<DiagramProps> =>
  REGISTRY[bulletId] ?? DiagramPlaceholder;
