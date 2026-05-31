/**
 * Brand font loading.
 *
 * Resolves the brand fonts through Remotion's @remotion/google-fonts
 * helpers so font data is bundled with the render. We use Outfit for
 * everything textual (titles AND body) — heavy weight for titles, regular
 * for body — and JetBrains Mono for the wordmark, scene counters, and
 * stage chips.
 *
 * Syne (the marketing site's display font) was tried first but proved
 * hard to read at video scale; Outfit at 800 weight gives the same
 * brand presence without sacrificing legibility.
 */

import { loadFont as loadOutfit } from "@remotion/google-fonts/Outfit";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

const outfit = loadOutfit();
const jetbrains = loadJetBrains();

export const fonts = {
  display: outfit.fontFamily,  // Outfit — titles (800), chapter titles (800)
  body: outfit.fontFamily,     // Outfit — body labels, paragraphs (400-600)
  mono: jetbrains.fontFamily,  // JetBrains Mono — wordmark, counters, chips
};
