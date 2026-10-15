import de from '../../../go/internal/i18n/messages.de.json';
import en from '../../../go/internal/i18n/messages.en.json';
import es from '../../../go/internal/i18n/messages.es.json';
import fr from '../../../go/internal/i18n/messages.fr.json';
import ja from '../../../go/internal/i18n/messages.ja.json';
import ko from '../../../go/internal/i18n/messages.ko.json';
import ptBR from '../../../go/internal/i18n/messages.pt-BR.json';
import vi from '../../../go/internal/i18n/messages.vi.json';
import zhCN from '../../../go/internal/i18n/messages.zh-CN.json';

type Catalog = Record<string, { one?: string; other?: string }>;

const catalogs: Record<string, Catalog> = {
  de,
  en,
  es,
  fr,
  ja,
  ko,
  'pt-BR': ptBR,
  vi,
  'zh-CN': zhCN,
};

/** Resolve the browser's preferred locale to one of the bundled catalogs. */
export function detectLanguage(): string {
  const preferences = typeof navigator === 'undefined'
    ? []
    : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const raw of preferences) {
    const locale = raw.replaceAll('_', '-').toLowerCase();
    if (
      locale.startsWith('zh-hant')
      || locale.startsWith('zh-tw')
      || locale.startsWith('zh-hk')
      || locale.startsWith('zh-mo')
    ) continue;
    if (locale.startsWith('zh')) return 'zh-CN';
    if (locale.startsWith('pt')) return 'pt-BR';
    const match = Object.keys(catalogs).find((catalog) =>
      locale === catalog.toLowerCase() || locale.startsWith(`${catalog.toLowerCase()}-`),
    );
    if (match) return match;
  }
  return 'en';
}

const englishSources = Object.entries(en)
  .map(([key, message]) => ({ key, source: message.other ?? '' }))
  .filter((entry) => entry.source !== '')
  .sort((left, right) => placeholderLiteralLength(right.source) - placeholderLiteralLength(left.source));

/** Resolve keyed copy from the shared Go i18n catalogs. */
export function translate(
  key: string,
  preference: string,
  resolvedLanguage: string,
): string {
  const locale = preference === 'auto' ? resolvedLanguage : preference;
  return catalogs[locale]?.[key]?.other ?? catalogs.en?.[key]?.other ?? key;
}

/** Resolve a plural catalog entry and interpolate its count. */
export function translatePlural(
  key: string,
  count: number,
  preference: string,
  resolvedLanguage: string,
): string {
  const locale = preference === 'auto' ? resolvedLanguage : preference;
  const message = catalogs[locale]?.[key] ?? catalogs.en?.[key];
  if (!message) return key;
  const category = new Intl.PluralRules(locale).select(count);
  const pattern = category === 'one' ? message.one ?? message.other : message.other ?? message.one;
  return (pattern ?? key).replaceAll('{count}', String(count));
}

/** Resolve legacy service messages through the same keyed English catalog. */
export function translateSource(
  source: string,
  preference: string,
  resolvedLanguage: string,
): string {
  for (const entry of englishSources) {
    const names: string[] = [];
    let cursor = 0;
    let expression = '^';
    const placeholders = /\{([A-Za-z0-9_]+)\}/gu;
    for (const match of entry.source.matchAll(placeholders)) {
      const index = match.index ?? 0;
      expression += escapeRegex(entry.source.slice(cursor, index));
      expression += '(.+?)';
      names.push(match[1]);
      cursor = index + match[0].length;
    }
    if (names.length === 0) {
      if (entry.source === source) return translate(entry.key, preference, resolvedLanguage);
      continue;
    }
    expression += `${escapeRegex(entry.source.slice(cursor))}$`;
    const captures = new RegExp(expression, 'u').exec(source);
    if (!captures) continue;
    let translated = translate(entry.key, preference, resolvedLanguage);
    names.forEach((name, index) => {
      translated = translated.replaceAll(`{${name}}`, captures[index + 1]);
    });
    return translated;
  }
  return source;
}

function placeholderLiteralLength(source: string): number {
  return source.replace(/\{[A-Za-z0-9_]+\}/gu, '').length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
