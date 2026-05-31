/**
 * Brand font loading.
 *
 * Resolves the three Google Fonts used by the worca marketing site through
 * Remotion's @remotion/google-fonts helpers, so font data is bundled with
 * the render instead of fetched at runtime.
 *
 * Marketing site --font-display / --font-body / --font-mono → Syne / Outfit /
 * JetBrains Mono.
 */

import { loadFont as loadSyne } from "@remotion/google-fonts/Syne";
import { loadFont as loadOutfit } from "@remotion/google-fonts/Outfit";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

const syne = loadSyne();
const outfit = loadOutfit();
const jetbrains = loadJetBrains();

export const fonts = {
  display: syne.fontFamily,    // Syne — headings, chapter titles
  body: outfit.fontFamily,     // Outfit — body / paragraphs
  mono: jetbrains.fontFamily,  // JetBrains Mono — wordmark, code, status pills
};
