import type { ReactNode } from 'react';

export function initials(value: unknown): string {
  return String(value || '?')
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function providerFamily(value: unknown): string {
  const normalized = String(value || '')
    .toLocaleLowerCase()
    .split(/[/:]/u)[0];
  if (['anthropic', 'claude', 'claude-code'].includes(normalized)) return 'claude';
  if (['codex', 'openai'].includes(normalized)) return 'openai';
  if (['gemini', 'gemini-cli', 'antigravity'].includes(normalized)) return 'gemini';
  if (['grok', 'xai', 'x-ai'].includes(normalized)) return 'grok';
  if (['proxy-hub', 'hub'].includes(normalized)) return 'proxy-hub';
  return normalized;
}

export function providerName(value: unknown): string {
  const family = providerFamily(value);
  if (family === 'claude') return 'Claude';
  if (family === 'openai') return 'OpenAI';
  if (family === 'gemini') return 'Google Gemini';
  if (family === 'kiro') return 'Kiro';
  if (family === 'openrouter') return 'OpenRouter';
  if (family === 'opencode') return 'OpenCode';
  if (family === 'grok') return 'Grok';
  if (family === 'proxy-hub') return 'Proxy Hub';
  return String(family || 'Provider')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function iconFile(value: unknown): string | null {
  const family = providerFamily(value);
  if (family === 'claude') return 'claude.svg';
  if (family === 'openai') return 'openai.svg';
  if (family === 'gemini') return 'googlegemini.svg';
  if (family === 'openrouter') return 'openrouter.svg';
  if (family === 'opencode') return 'opencode.svg';
  if (family === 'kiro') return 'kiro.svg';
  if (family === 'grok') return 'grok.svg';
  return null;
}

export function ProviderIcon({
  value,
  size = '',
}: {
  value: unknown;
  size?: 'small' | 'medium' | 'chip' | '';
}): ReactNode {
  const family = providerFamily(value);
  const file = iconFile(value);
  const className = `provider provider-${family.replaceAll(/[^a-z0-9]/gu, '-') || 'unknown'}${size ? ` ${size}` : ''}`;
  if (file) {
    return (
      <span className={className} aria-hidden="true">
        <img src={`./icons/${file}`} alt="" />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {initials(value)}
    </span>
  );
}
