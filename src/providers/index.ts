import type { ProviderRegistry } from '../core/registry';
import { codexProvider } from './codex';
import { geminiProvider } from './gemini';
import { grokProvider } from './grok';
import { kiroProvider } from './kiro';
import { opencodeProvider } from './opencode';

/**
 * Register built-in providers. Call once at CLI startup.
 * To add a provider: implement Provider, import here, register().
 */
export function registerBuiltinProviders(registry: ProviderRegistry): void {
  registry.register(codexProvider);
  registry.register(geminiProvider);
  registry.register(grokProvider);
  registry.register(kiroProvider);
  registry.register(opencodeProvider);
}

export { codexProvider, geminiProvider, grokProvider, kiroProvider, opencodeProvider };
