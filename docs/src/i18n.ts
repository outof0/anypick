import i18next, { type TFunction } from "i18next";
import en from "./i18n/locales/en.json";
import zhCNMessages from "./i18n/locales/zh-CN.json";
import esMessages from "./i18n/locales/es.json";
import frMessages from "./i18n/locales/fr.json";
import deMessages from "./i18n/locales/de.json";
import jaMessages from "./i18n/locales/ja.json";
import koMessages from "./i18n/locales/ko.json";
import ptBRMessages from "./i18n/locales/pt-BR.json";
import viMessages from "./i18n/locales/vi.json";

type CatalogShape<T> = {
  [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]>;
};

// Simplified Chinese has a dedicated landing page instead of the shared page
// backed by the `landing` catalog section.
const zhCN: CatalogShape<Omit<typeof en, "landing">> = zhCNMessages;
const es: CatalogShape<typeof en> = esMessages;
const fr: CatalogShape<typeof en> = frMessages;
const de: CatalogShape<typeof en> = deMessages;
const ja: CatalogShape<typeof en> = jaMessages;
const ko: CatalogShape<typeof en> = koMessages;
const ptBR: CatalogShape<typeof en> = ptBRMessages;
const vi: CatalogShape<typeof en> = viMessages;

// Keep locale routes in one registry; UI copy lives in the locale catalogs.
const localePaths = {
  en: "",
  "zh-CN": "/zh-cn",
  es: "/es",
  fr: "/fr",
  de: "/de",
  ja: "/ja",
  ko: "/ko",
  "pt-BR": "/pt-br",
  vi: "/vi",
} as const;

export type Locale = keyof typeof localePaths;
export const supportedLocales = Object.keys(localePaths) as Locale[];
export const localeNames: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
  ko: "한국어",
  "pt-BR": "Português (Brasil)",
  vi: "Tiếng Việt",
};

const instance = i18next.createInstance();
const initialized = instance.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
    ja: { translation: ja },
    ko: { translation: ko },
    "pt-BR": { translation: ptBR },
    vi: { translation: vi },
  },
  interpolation: { escapeValue: false },
});

export function localeForPath(pathname: string): Locale {
  return supportedLocales.find((locale) => {
    const prefix = localePaths[locale];
    return prefix !== "" && (pathname === prefix || pathname.startsWith(`${prefix}/`));
  }) ?? "en";
}

export function localePrefix(locale: Locale): string {
  return localePaths[locale];
}

export function docsNavigationMessage(label: string) {
  switch (label) {
    case "Home": return "header.docs";
    case "Apps & Terminal UI": return "docsNav.appsTerminalUi";
    case "Guides": return "docsNav.guides";
    case "Reference": return "docsNav.reference";
    default: return undefined;
  }
}

export function localizedPath(locale: Locale, path: string): string {
  const normalized = (path.startsWith("/") ? path : `/${path}`)
    .replace(/^\/+/, "/")
    .replace(/\/+$/, "") || "/";
  const prefix = localePrefix(locale);
  if (normalized === "/") {
    if (locale === "en") return "/";
    return `${prefix}/`;
  }
  return `${prefix}${normalized}`;
}

export function languageSwitchHref(pathname: string, targetLocale: Locale): string {
  const currentLocale = localeForPath(pathname);
  const currentPrefix = localePrefix(currentLocale);
  const path = currentPrefix !== "" && (pathname === currentPrefix || pathname.startsWith(`${currentPrefix}/`))
    ? pathname.slice(currentPrefix.length) || "/"
    : pathname;
  return localizedPath(targetLocale, path);
}

export async function getTranslator(locale: Locale): Promise<TFunction> {
  await initialized;
  return instance.getFixedT(locale, "translation");
}
