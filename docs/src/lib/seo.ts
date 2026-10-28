import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { localeForPath, localePrefix, supportedLocales, type Locale } from "../i18n";

// Shared by the page head (BaseLayout) and the sitemap serializer
// (astro.config.ts), so both advertise the same language alternates. Paths are
// resolved from the working directory because the build always runs in docs/
// and the bundled page code no longer sits next to its source.
const contentRoot = join(process.cwd(), "src", "content");

/** The locale-independent part of a URL path: "/vi/docs/x/" → "/docs/x". */
function basePath(pathname: string, locale: Locale): string {
  const rest = pathname.slice(localePrefix(locale).length).replace(/\/$/, "");
  return rest === "" ? "/" : rest;
}

function hasDocsSource(locale: Locale, base: string): boolean {
  const slug = base === "/docs" ? "docs/index" : base.slice(1);
  const dir = locale === "en" ? contentRoot : join(contentRoot, localePrefix(locale).slice(1));
  return existsSync(join(dir, `${slug}.mdx`)) || existsSync(join(dir, `${slug}.md`));
}

function existsIn(locale: Locale, base: string): boolean {
  // Every locale ships a landing page; docs pages exist only where translated,
  // and an alternate pointing at a missing page is worse than none.
  if (base === "/") return true;
  return base.startsWith("/docs") && hasDocsSource(locale, base);
}

export type Alternate = { hreflang: string; href: string };

/**
 * hreflang alternates for a page: one per locale that has the page, plus
 * x-default on the English one. Empty when no other locale has it.
 */
export function localeAlternates(pathname: string, site: URL | string): Alternate[] {
  const base = basePath(pathname, localeForPath(pathname));
  if (base !== "/" && !base.startsWith("/docs")) return [];
  const present = supportedLocales.filter((locale) => existsIn(locale, base));
  if (present.length < 2) return [];
  const href = (locale: Locale) =>
    new URL(`${localePrefix(locale)}${base === "/" ? "/" : `${base}/`}`, site).href;
  const alternates: Alternate[] = present.map((locale) => ({ hreflang: locale, href: href(locale) }));
  if (present.includes("en")) alternates.push({ hreflang: "x-default", href: href("en") });
  return alternates;
}

function sourcesFor(pathname: string): string[] {
  const locale = localeForPath(pathname);
  const base = basePath(pathname, locale);
  if (base === "/") {
    const page = locale === "zh-CN" ? "src/pages/zh-cn/index.astro" : "src/pages/index.astro";
    return [page, `src/i18n/locales/${locale}.json`, "src/data/release.json"];
  }
  const slug = base === "/docs" ? "docs/index" : base.slice(1);
  const dir = locale === "en" ? "src/content" : `src/content/${localePrefix(locale).slice(1)}`;
  return [`${dir}/${slug}.mdx`, `${dir}/${slug}.md`];
}

let commitDates: Map<string, string> | null = null;

/** Newest commit date per docs/ file, read from git once per build. */
function loadCommitDates(): Map<string, string> {
  if (commitDates) return commitDates;
  commitDates = new Map();
  try {
    // A shallow clone dates every file at the one fetched commit, which is a
    // wrong lastmod on every page; no lastmod is the honest answer there.
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim();
    if (shallow === "true") return commitDates;
    const log = execFileSync("git", ["log", "--format=@%cI", "--name-only", "--relative", "--", "src"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let date = "";
    for (const line of log.split("\n")) {
      if (line.startsWith("@")) date = line.slice(1);
      else if (line && !commitDates.has(line)) commitDates.set(line, date);
    }
  } catch {
    // No git (a source tarball): the sitemap simply omits lastmod.
  }
  return commitDates;
}

/**
 * When the page's own source last changed. Undefined when git cannot say, so
 * a shallow or missing history never stamps every page with one build date.
 */
export function lastModified(pathname: string): string | undefined {
  const dates = loadCommitDates();
  return sourcesFor(pathname)
    .map((file) => dates.get(file))
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
}
