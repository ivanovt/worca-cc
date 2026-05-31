/**
 * Diagram registry — maps bullet ID (1..18) to the React component that
 * renders that bullet's diagram.
 *
 * Every bullet has a bespoke diagram now; the constellation placeholder
 * is kept available as a fallback in case a future bullet is added without
 * an entry here.
 */

import type React from "react";

import { DiagramPlaceholder } from "./DiagramPlaceholder";

import { Diagram01Orchestrator } from "./Diagram01Orchestrator";
import { Diagram02Context } from "./Diagram02Context";
import { Diagram03Template } from "./Diagram03Template";
import { Diagram04Inputs } from "./Diagram04Inputs";
import { Diagram05Graph } from "./Diagram05Graph";
import { Diagram06Pipeline } from "./Diagram06Pipeline";
import { Diagram07Guardrails } from "./Diagram07Guardrails";
import { Diagram08Governance } from "./Diagram08Governance";
import { Diagram09Loops } from "./Diagram09Loops";
import { Diagram10Cost } from "./Diagram10Cost";
import { Diagram11UI } from "./Diagram11UI";
import { Diagram12UIDetail } from "./Diagram12UIDetail";
import { Diagram13Modes } from "./Diagram13Modes";
import { Diagram14Layers } from "./Diagram14Layers";
import { Diagram15Templates } from "./Diagram15Templates";
import { Diagram16Events } from "./Diagram16Events";
import { Diagram17Chat } from "./Diagram17Chat";
import { Diagram18Beads } from "./Diagram18Beads";

export interface DiagramProps {
  /** Word count of the bullet — diagrams use this to pace their reveal
   *  so element timing tracks the narration window. */
  words: number;
}

const REGISTRY: Partial<Record<number, React.FC<DiagramProps>>> = {
  1: Diagram01Orchestrator,
  2: Diagram02Context,
  3: Diagram03Template,
  4: Diagram04Inputs,
  5: Diagram05Graph,
  6: Diagram06Pipeline,
  7: Diagram07Guardrails,
  8: Diagram08Governance,
  9: Diagram09Loops,
  10: Diagram10Cost,
  11: Diagram11UI,
  12: Diagram12UIDetail,
  13: Diagram13Modes,
  14: Diagram14Layers,
  15: Diagram15Templates,
  16: Diagram16Events,
  17: Diagram17Chat,
  18: Diagram18Beads,
};

export const diagramFor = (bulletId: number): React.FC<DiagramProps> =>
  REGISTRY[bulletId] ?? DiagramPlaceholder;
