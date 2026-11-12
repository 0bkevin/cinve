import type { Html } from './jsx.js';
import { icons } from './ui.js';
import { canonicalUrl, type Locale } from './locale.js';
import es from './locales/es.js';
import en from './locales/en.js';

export type CatalogShape<T> = T extends string ? string : T extends readonly unknown[] ? { [K in keyof T]: CatalogShape<T[K]> } : T extends object ? { [K in keyof T]: CatalogShape<T[K]> } : T;
export type Catalog = CatalogShape<typeof es>;
export const catalog = (locale: Locale): Catalog => locale === 'en' ? en : es;
export const cinemas = ['Cinex', 'Cines Unidos', 'Cinepic', 'Supercines', 'Gran Cine'] as const;
export type Access = 'open' | 'account' | 'none';
type Each<T extends readonly unknown[], V> = { -readonly [K in keyof T]: V };
type PerCinema = Each<typeof cinemas, Access>;
const access: PerCinema[] = [['open', 'open', 'open', 'open', 'open'], ['account', 'account', 'open', 'open', 'none'], ['account', 'account', 'open', 'none', 'none'], ['account', 'open', 'none', 'open', 'none']];
export function coverage(locale: Locale) {
  return catalog(locale).landing.coverage.map(({ topic, ask }, i) => ({ topic, ask, access: access[i]! }));
}
export function accessLabel(locale: Locale): Record<Access, string> { return catalog(locale).landing.access; }
export type LogoFile = 'claudecode.svg' | 'codex.png' | 'opencode.svg' | 'antigravity.svg' | 'hermes.svg' | 'openclaw.svg';
export const assistants: { name: string; logo: LogoFile; setup: (endpoint: string) => string; file?: string }[] = [
  { name: 'Claude Code', logo: 'claudecode.svg', setup: url => `claude mcp add --transport http cinve ${url}` },
  { name: 'Codex', logo: 'codex.png', file: '~/.codex/config.toml', setup: url => `[mcp_servers.cinve]\nurl = "${url}"` },
  { name: 'OpenCode', logo: 'opencode.svg', setup: url => `opencode mcp add cinve --global --url ${url}` },
  { name: 'Antigravity', logo: 'antigravity.svg', setup: url => `agy mcp add cinve ${url}` },
  { name: 'Hermes', logo: 'hermes.svg', setup: url => `hermes mcp add cinve --url ${url}` },
  { name: 'OpenClaw', logo: 'openclaw.svg', setup: url => `openclaw mcp add cinve --url ${url} --transport streamable-http` },
];

export function safeguardSummary(locale: Locale) { return catalog(locale).landing.safeguardSummary; }
export function safeguards(locale: Locale): [icon: Html, title: string, text: string][] {
  const source = catalog(locale).landing.safeguards;
  const iconsList = [icons.keyRound(), icons.lock(), icons.link(), icons.shieldCheck(), icons.unplug(), icons.eyeOff()];
  return source.map(([title, text], i) => [iconsList[i]!, title, text]);
}
export function faq(locale: Locale) { return catalog(locale).landing.faq; }

/** Localized structured data mirrors the visible landing-page claims and FAQ. */
export const structuredData = (origin: string, locale: Locale = 'es') => {
  const copy = catalog(locale).landing;
  const language = locale === 'es' ? 'es-VE' : 'en-US';
  const pageUrl = canonicalUrl(`${origin}/`, locale);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${pageUrl}#website`, url: pageUrl, name: 'Cinve', inLanguage: language, publisher: { '@id': 'https://kevinbravo.com/#person' } },
      { '@type': 'SoftwareApplication', '@id': `${pageUrl}#app`, name: 'Cinve', url: pageUrl, description: copy.description,
        applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any (remote MCP server)', isAccessibleForFree: true,
        license: 'https://opensource.org/license/mit', inLanguage: language, areaServed: { '@type': 'Country', name: 'Venezuela' },
        sameAs: ['https://github.com/0bkevin/cinve'], author: { '@id': 'https://kevinbravo.com/#person' },
        mainEntity: { '@type': 'FAQPage', inLanguage: language, mainEntity: copy.faq.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })) } },
      { '@type': 'Person', '@id': 'https://kevinbravo.com/#person', name: 'Kevin Bravo', url: 'https://kevinbravo.com' },
    ],
  };
};
