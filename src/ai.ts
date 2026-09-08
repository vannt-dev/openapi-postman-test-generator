import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { AgentPlan, OpenApiSpec } from './types';

const AgentPlanSchema = z.object({
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

export async function createAgentPlan(spec: OpenApiSpec, model: string): Promise<AgentPlan> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when --ai is enabled');
  const client = new OpenAI();
  const operations = Object.entries(spec.paths).flatMap(([route, pathItem]) =>
    ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].flatMap(method => {
      const operation = pathItem[method as keyof typeof pathItem];
      if (!operation || Array.isArray(operation) || !('responses' in operation)) return [];
      return [{
        operationId: operation.operationId || `${method} ${route}`,
        method: method.toUpperCase(),
        route,
        summary: operation.summary || '',
        parameters: (operation.parameters || []).map(parameter => '$ref' in parameter ? parameter.$ref : `${parameter.in}:${parameter.name}`),
        responseCodes: Object.keys(operation.responses),
      }];
    }),
  );
  const response = await client.responses.parse({
    model,
    input: [
      {
        role: 'system',
        content: [
          'You plan safe API test workflows from an OpenAPI operation summary.',
          'Order create/authentication operations before dependent reads and updates, and cleanup deletes last.',
          'Map response identifiers to variables only when the relationship is well supported.',
          'Never invent operation IDs. Report uncertainty in warnings.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ title: spec.info.title, operations }) },
    ],
    text: { format: zodTextFormat(AgentPlanSchema, 'api_test_plan') },
  });
  if (!response.output_parsed) throw new Error('The AI provider returned no structured workflow plan');
  return response.output_parsed;
}
