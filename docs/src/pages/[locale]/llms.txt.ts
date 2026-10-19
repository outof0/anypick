import { getCollection, type CollectionEntry } from "astro:content";
import { config } from "virtual:nimbus/config";
import { getTranslator, type Locale } from "@/i18n";

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
  locale: Locale;
  route: string;
  entries: LocalizedDocEntry[];
}

export const prerender = true;

export async function getStaticPaths() {
  return Promise.all(localeCollections.map(async ({ locale, route, collection }) => ({
    params: { locale: route },
    props: { locale, route, entries: await getCollection(collection) as LocalizedDocEntry[] },
  })));
}

export async function GET({ props }: { props: Props }) {
  const { locale, route, entries } = props;
  const t = await getTranslator(locale);
  const pages = [...entries]
    .filter((entry) => !entry.data.draft)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => {
      const slug = route === "zh-cn" ? entry.id.replace(/^zh-cn\//, "") : entry.id;
      const markdownPath = `/${route}/${slug}/index.md`;
      const description = entry.data.description ? ` — ${entry.data.description}` : "";
      return `- [${entry.data.title}](${new URL(markdownPath, config.site).href})${description}`;
    });

  const lines = [
    `# AnyPick — ${t("header.docs")}`,
    "",
    t("docsNav.reference"),
    "",
    ...pages,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
