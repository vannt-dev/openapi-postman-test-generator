import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AgentPlanSchema, AiProvider, PlanningInput, PlanningOptions, ProviderCapabilities } from '../ai-contract';
import { AiProviderConfig } from '../types';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = { usesApiKey: true, usesLocalLogin: false, structuredOutput: true };
  constructor(private readonly config: AiProviderConfig = {}) {}

  async generate(input: PlanningInput, options: PlanningOptions): Promise<unknown> {
    const keyName = this.config.apiKeyEnv || 'OPENAI_API_KEY';
    const apiKey = process.env[keyName];
    if (!apiKey) throw new Error(`${keyName} is required for the OpenAI provider.`);
    const model = options.model || this.config.model;
    if (!model) throw new Error('A model is required for the OpenAI provider.');
    const client = new OpenAI({ apiKey, timeout: options.timeoutMs });
    const response = await client.responses.parse({
      model,
      input: [{ role: 'user', content: input.prompt }],
      text: { format: zodTextFormat(AgentPlanSchema, 'agent_plan') },
    });
    if (!response.output_parsed) throw new Error('The OpenAI provider returned no structured plan.');
    if (Buffer.byteLength(JSON.stringify(response.output_parsed), 'utf8') > options.maxOutputBytes) {
      throw new Error(`The OpenAI provider exceeded the ${options.maxOutputBytes}-byte output limit.`);
    }
    return response.output_parsed;
  }
}
