import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { z } from 'zod';
import { ProjectConfig } from './types';

const variableMappingSchema = z.object({
  sourceOperationId: z.string().min(1),
  responseJsonPath: z.string().min(1),
  variable: z.string().min(1),
  targetOperationIds: z.array(z.string().min(1)).optional(),
}).strict();

const negativeScenarioSchema = z.object({
  operationId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['missing_required', 'boundary', 'invalid_enum', 'unauthorized']),
  field: z.string().min(1).nullable().optional(),
}).strict();

const providerSchema = z.object({
  type: z.enum(['openai', 'codex', 'claude', 'antigravity', 'command']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  input: z.enum(['stdin', 'argument']).optional(),
  output: z.enum(['stdout-json', 'stdout-text', 'output-file']).optional(),
}).strict();

const projectConfigSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  responseTimeMs: z.number().positive().optional(),
  safeMode: z.boolean().optional(),
  includeNegative: z.boolean().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  operationOrder: z.array(z.string().min(1)).optional(),
  variableMappings: z.array(variableMappingSchema).optional(),
  negativeScenarios: z.array(negativeScenarioSchema).optional(),
  disabledOperations: z.array(z.string().min(1)).optional(),
  profiles: z.record(z.string(), z.object({
    baseUrl: z.string().min(1).optional(),
    variables: z.record(z.string(), z.string()).optional(),
    environmentName: z.string().min(1).optional(),
  }).strict()).optional(),
  ai: z.object({
    provider: z.string().min(1).optional(),
    fallback: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    timeoutMs: z.number().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    providers: z.record(z.string(), providerSchema).optional(),
  }).strict().optional(),
}).strict();

export function loadProjectConfig(file?: string): ProjectConfig {
  if (!file) return {};
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Config file not found: ${absolute}`);
  const value = load(fs.readFileSync(absolute, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The config file must contain an object');
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid project configuration: ${details}`);
  }
  return result.data as ProjectConfig;
}
