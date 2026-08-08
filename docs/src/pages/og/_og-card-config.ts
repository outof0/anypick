/**
 * Shared visual config for build-time OG cards.
 *
 * Edit this file to retune generated card colors, spacing, and fonts. Both
 * the per-page endpoint (`og/[...slug].ts`) and the homepage fallback
 * (`og.png.ts`) spread this object into `astro-og-canvas`.
 *
 * Leading underscore tells Astro to skip routing for this file — it sits
 * inside `src/pages/` to be next to its consumers, but it's not a route.
 */

import type { OGImageOptions } from "astro-og-canvas";

export const ogCardConfig = {
  // Hotplug navy, warming toward the violet end of the logomark gradient.
  bgGradient: [
    [11, 16, 32],
    [26, 24, 64],
  ],
  border: { color: [106, 92, 255], width: 8, side: "inline-start" },
  padding: 96,
  fonts: ["./public/fonts/Inter-Bold.ttf"],
  font: {
    title: {
      color: [242, 244, 248],
      size: 64,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.1,
    },
    description: {
      color: [154, 163, 190],
      size: 32,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.3,
    },
  },
  format: "PNG",
} satisfies Partial<OGImageOptions>;
