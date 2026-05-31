/**
 * Remotion config.
 *
 * NOTE: Tailwind is intentionally NOT enabled — the worca brand styles are
 * driven by a typed token object (src/theme.ts) rendered through inline
 * `style` props. The Remotion best-practices guide forbids CSS transitions
 * and Tailwind animation classes (they don't render frame-accurately), so
 * we drive every animation through useCurrentFrame() + interpolate().
 *
 * When using the Node.JS render APIs, this file is NOT picked up — pass
 * options directly. See https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
