import { getCollection, type CollectionEntry } from "astro:content";
import { renderEntryAsMarkdown } from "nimbus-docs";
import type { Locale } from "@/i18n";

const localeCollections = [
  { locale: "es", route: "es", collection: "_docsEs" },
  { locale: "fr", route: "fr", collection: "_docsFr" },
  { locale: "de", route: "de", collection: "_docsDe" },
  { locale: "ja", route: "ja", collection: "_docsJa" },
  { locale: "ko", route: "ko", collection: "_docsKo" },
  { locale: "pt-BR", route: "pt-br", collection: "_docsPtBr" },
  { locale: "vi", route: "vi", collection: "_docsVi" },
  { locale: "zh-CN", route: "zh-cn", collection: "_docsZh" },
] as const;

type LocalizedDocEntry =
  | CollectionEntry<"_docsEs">
  | CollectionEntry<"_docsFr">
  | CollectionEntry<"_docsDe">
  | CollectionEntry<"_docsJa">
  | CollectionEntry<"_docsKo">
  | CollectionEntry<"_docsPtBr">
  | CollectionEntry<"_docsVi">
  | CollectionEntry<"_docsZh">;

interface Props {
  entry: LocalizedDocEntry;
  locale: Locale;
}

export const prerender = true;

export async function getStaticPaths() {
  const paths = await Promise.all(localeCollections.map(async ({ locale, route, collection }) => {
    const entries = await getCollection(collection) as LocalizedDocEntry[];
    return entries.map((entry) => ({
      params: { locale: route, slug: collection === "_docsZh" ? entry.id.replace(/^zh-cn\//, "") : entry.id },
      props: { entry, locale },
    }));
  }));
  return paths.flat();
}

export async function GET({ props }: { props: Props }) {
  const { entry } = props;
  const title = entry.data.title;
  const description = entry.data.description;
  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    renderEntryAsMarkdown(entry),
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
