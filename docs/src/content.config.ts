import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "nimbus-docs/content";

function localizedDocsCollection(base: string) {
  return defineCollection(
    docsCollection({
      // IDs stay `docs/<slug>` so Nimbus can build the existing docs sidebar
      // against this locale's content without inventing a second URL scheme.
      base,
      pattern: "docs/**/*.{md,mdx}",
      schemaFields: {
        audience: z.literal("human").optional(),
      },
    }),
  );
}

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
  _docsZh: defineCollection(
    docsCollection({
      base: ".",
      pattern: "zh-cn/docs/**/*.{md,mdx}",
      schemaFields: {
        audience: z.literal("human").optional(),
      },
    }),
  ),
  _docsEs: localizedDocsCollection("es"),
  _docsFr: localizedDocsCollection("fr"),
  _docsDe: localizedDocsCollection("de"),
  _docsJa: localizedDocsCollection("ja"),
  _docsKo: localizedDocsCollection("ko"),
  _docsPtBr: localizedDocsCollection("pt-br"),
  _docsVi: localizedDocsCollection("vi"),
  partials: defineCollection(partialsCollection()),
};
