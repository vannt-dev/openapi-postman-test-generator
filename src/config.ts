import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { ProjectConfig } from './types';

export function loadProjectConfig(file?: string): ProjectConfig {
  if (!file) return {};
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Config file not found: ${absolute}`);
  const value = load(fs.readFileSync(absolute, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The config file must contain an object');
  return value as ProjectConfig;
}
