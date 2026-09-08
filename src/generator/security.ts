import { SecurityScheme } from '../types';

export type SecuritySchemeKind = 'apiKey' | 'basic' | 'bearer';

export function classifySecurityScheme(scheme?: SecurityScheme): SecuritySchemeKind | undefined {
  if (!scheme) return undefined;
  if (scheme.type === 'apiKey') return 'apiKey';
  if ((scheme.type === 'http' && scheme.scheme === 'basic') || scheme.type === 'basic') return 'basic';
  if ((scheme.type === 'http' && scheme.scheme === 'bearer') || scheme.type === 'oauth2') return 'bearer';
  return undefined;
}
