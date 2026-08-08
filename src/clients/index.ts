import type { ClientRegistry } from './registry';
import { claudeCodeClient } from './claude-code';
import { codexClient } from './codex';
import { geminiClient } from './gemini';
import { kiroClient } from './kiro';

export function registerBuiltinClients(registry: ClientRegistry): void {
  registry.register(claudeCodeClient);
  registry.register(codexClient);
  registry.register(geminiClient);
  registry.register(kiroClient);
}

export { claudeCodeClient, codexClient, geminiClient, kiroClient };
export { ClientRegistry, clientRegistry } from './registry';
export { createClaudeCodeClient } from './claude-code';
export { createCodexClient } from './codex';
export { createGeminiClient } from './gemini';
export { createKiroClient } from './kiro';
export {
  CLAUDE_MODEL_ROLES,
  CODEX_DESKTOP_MODEL_ROLES,
  DEFAULT_MODEL_ROLE,
  defaultModelRolesForProxy,
  modelDefaultsForSuggestions,
  modelRolesForClient,
  modelRolesFromClientOptions,
  normalizeModelRoles,
  suggestModelsForProxyProvider,
} from './model-roles';
