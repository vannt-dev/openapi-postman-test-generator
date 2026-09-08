import { AiProvider, createPlanningInput, validateAgentPlan } from './ai-contract';
import { AntigravityProvider, ClaudeProvider, CodexProvider } from './providers/cli';
import { CustomCommandProvider } from './providers/command';
import { OpenAiProvider } from './providers/openai';
import { AgentPlan, AiProviderConfig, OpenApiSpec } from './types';

export interface AiPlanningRequest {
  provider: string;
  fallback?: string[];
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  providers?: Record<string, AiProviderConfig>;
}

export interface AiPlanningResult {
  plan: AgentPlan;
  provider: string;
  failedProviders: Array<{ provider: string; error: string }>;
}

export class AiProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();
  register(provider: AiProvider): this { this.providers.set(provider.name.toLowerCase(), provider); return this; }
  get(name: string): AiProvider | undefined { return this.providers.get(name.toLowerCase()); }
  names(): string[] { return [...this.providers.keys()]; }
}

export function createProviderRegistry(configs: Record<string, AiProviderConfig> = {}): AiProviderRegistry {
  const registry = new AiProviderRegistry();
  registry.register(new OpenAiProvider(configs.openai));
  registry.register(new CodexProvider(configs.codex));
  registry.register(new ClaudeProvider(configs.claude));
  registry.register(new AntigravityProvider(configs.antigravity || configs.agy));
  for (const [name, config] of Object.entries(configs)) {
    const type = config.type || name.toLowerCase();
    if (type === 'command') registry.register(new CustomCommandProvider(name, config));
  }
  return registry;
}

export async function planWithProviders(
  spec: OpenApiSpec,
  request: AiPlanningRequest,
  registry = createProviderRegistry(request.providers),
): Promise<AiPlanningResult> {
  const names = [...new Set([request.provider, ...(request.fallback || [])].map((name) => name.trim()).filter(Boolean))];
  const failedProviders: AiPlanningResult['failedProviders'] = [];
  const input = createPlanningInput(spec);
  for (const name of names) {
    const provider = registry.get(name);
    if (!provider) {
      failedProviders.push({ provider: name, error: `Unknown provider. Available providers: ${registry.names().join(', ')}` });
      continue;
    }
    try {
      const providerConfig = request.providers?.[name];
      const rawPlan = await provider.generate(input, {
        model: request.model || providerConfig?.model,
        timeoutMs: request.timeoutMs || providerConfig?.timeoutMs || 120_000,
        maxOutputBytes: request.maxOutputBytes || providerConfig?.maxOutputBytes || 1_048_576,
      });
      return { plan: validateAgentPlan(rawPlan), provider: name, failedProviders };
    } catch (error) {
      failedProviders.push({ provider: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error(`All AI providers failed: ${failedProviders.map((item) => `${item.provider}: ${item.error}`).join('; ')}`);
}

/** Backward-compatible OpenAI-only entry point. */
export async function createAgentPlan(spec: OpenApiSpec, model: string): Promise<AgentPlan> {
  return (await planWithProviders(spec, { provider: 'openai', model })).plan;
}

export { AgentPlanSchema, AGENT_PLAN_JSON_SCHEMA, buildPlanningPrompt, validateAgentPlan } from './ai-contract';
export type { AiProvider, PlanningInput, PlanningOptions, ProviderCapabilities } from './ai-contract';
