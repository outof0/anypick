import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      // Mount the docs under `/docs/*` so `/` is free for the landing page.
      // Entry ids are relative to `base` and nimbus derives URLs from ids, so
      // basing on `src/content` and globbing `docs/**` prefixes every id with
      // `docs/`. Files themselves stay in `src/content/docs/`.
      base: ".",
      pattern: "docs/**/*.{md,mdx}",
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
};
