import { z } from 'zod';
import { AgentPlan, OpenApiSpec } from './types';

export const AgentPlanSchema = z.object({
  operationOrder: z.array(z.string()),
  variableMappings: z.array(z.object({
    sourceOperationId: z.string(),
    responseJsonPath: z.string(),
    variable: z.string(),
    targetOperationIds: z.array(z.string()),
  })),
  negativeScenarios: z.array(z.object({
    operationId: z.string(),
    name: z.string(),
    kind: z.enum(['missing_required', 'boundary', 'invalid_enum', 'unauthorized']),
    field: z.string().nullable(),
  })),
  warnings: z.array(z.string()),
});

export const AGENT_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operationOrder', 'variableMappings', 'negativeScenarios', 'warnings'],
  properties: {
    operationOrder: { type: 'array', items: { type: 'string' } },
    variableMappings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceOperationId', 'responseJsonPath', 'variable', 'targetOperationIds'],
        properties: {
          sourceOperationId: { type: 'string' },
          responseJsonPath: { type: 'string' },
          variable: { type: 'string' },
          targetOperationIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    negativeScenarios: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operationId', 'name', 'kind', 'field'],
        properties: {
          operationId: { type: 'string' },
          name: { type: 'string' },
          kind: { enum: ['missing_required', 'boundary', 'invalid_enum', 'unauthorized'] },
          field: { type: ['string', 'null'] },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface PlanningInput {
  spec: OpenApiSpec;
  prompt: string;
  schema: typeof AGENT_PLAN_JSON_SCHEMA;
}

export interface PlanningOptions {
  model?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProviderCapabilities {
  usesApiKey: boolean;
  usesLocalLogin: boolean;
  structuredOutput: boolean;
}

export interface AiProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  generate(input: PlanningInput, options: PlanningOptions): Promise<unknown>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export function buildPlanningPrompt(spec: OpenApiSpec): string {
  const operations = Object.entries(spec.paths).flatMap(([path, pathItem]) =>
    METHODS.flatMap((method) => {
      const operation = pathItem[method];
      if (!operation) return [];
      return [{
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId || `${method} ${path}`,
        summary: operation.summary,
        parameters: operation.parameters,
        requestBody: operation.requestBody,
        responses: Object.keys(operation.responses || {}),
      }];
    }),
  );

  return [
    'You are an API test planning engine.',
    'Analyze the supplied OpenAPI operation summary and return only an object matching the JSON schema.',
    'Do not execute tools, edit files, call APIs, or include markdown.',
    'Order dependent operations, identify response values that later requests can reuse, and propose useful negative tests.',
    'Use JSONPath expressions compatible with Postman, such as $.id.',
    'Only reference operation IDs present in the input, including generated method-and-path IDs. Put ambiguity or unsafe assumptions in warnings.',
    '',
    JSON.stringify({ title: spec.info.title, version: spec.info.version, operations }),
  ].join('\n');
}

export function createPlanningInput(spec: OpenApiSpec): PlanningInput {
  return { spec, prompt: buildPlanningPrompt(spec), schema: AGENT_PLAN_JSON_SCHEMA };
}

export function validateAgentPlan(value: unknown): AgentPlan {
  return AgentPlanSchema.parse(value) as AgentPlan;
}
