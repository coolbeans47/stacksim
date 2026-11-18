import { AwsError } from '../errors.js';
import type { Json } from './query.js';
export const COMPARISON_CATEGORIES = ['aliases', 'templates', 'ingest_pipelines', 'ism_policies', 'security_roles', 'security_role_mappings', 'security_internal_users'] as const;
export type ComparisonCategory = typeof COMPARISON_CATEGORIES[number];
export function comparisonCategories(input: unknown): ComparisonCategory[] {
  if (!Array.isArray(input) || !input.length || input.length > COMPARISON_CATEGORIES.length || new Set(input).size !== input.length || input.some(value => !COMPARISON_CATEGORIES.includes(value))) throw new AwsError('ValidationException', `Choose distinct supported categories: ${COMPARISON_CATEGORIES.join(', ')}`, 400);
  return input;
}
const plain = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Counts cover every item; bounded field detail never contains password verifier material. */
export function compareMetadata(category: ComparisonCategory, source: Record<string, Json>, target: Record<string, Json>, budget = { nodes: 0, deadline: performance.now() + 30000 }): Json {
  const result: Json = { Status: 'compared', InSync: 0, SourceOnly: 0, TargetOnly: 0, Diverged: 0, Items: { SourceOnly: [], TargetOnly: [], Diverged: [] }, Truncated: false };
  let bytes = 0;
  const admit = (value: any, list: any[], max: number): boolean => {
    const size = Buffer.byteLength(JSON.stringify(value)); if (list.length >= max || bytes + size > 1024 * 1024) { result.Truncated = true; return false; } bytes += size; list.push(value); return true;
  };
  for (const name of [...new Set([...Object.keys(source), ...Object.keys(target)])].sort()) {
    if (!Object.hasOwn(source, name) || !Object.hasOwn(target, name)) { const side = Object.hasOwn(source, name) ? 'SourceOnly' : 'TargetOnly'; result[side]++; if (name.length <= 256) admit(name, result.Items[side], 1000); else result.Truncated = true; continue; }
    let differs = false; const fields: Json[] = [];
    const walk = (left: any, right: any, path: string, depth: number): void => {
      if (++budget.nodes > 1000000 || performance.now() > budget.deadline) throw new AwsError('LimitExceededException', 'Metadata comparison exceeds one million fields or 30 seconds', 429);
      if (Object.is(left, right)) return;
      if (depth > 32) { differs = true; result.Truncated = true; return; }
      if (plain(left) && plain(right)) { for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) ? path ? `${path}.${key}` : key : `${path}[${JSON.stringify(key)}]`, depth + 1); return; }
      if (Array.isArray(left) && Array.isArray(right)) { for (let i = 0; i < Math.max(left.length, right.length); i++) walk(left[i], right[i], `${path}[${i}]`, depth + 1); return; }
      differs = true;
      const redacted = category === 'security_internal_users' && (path === 'hash' || path.startsWith('hash.'));
      const field: Json = { Path: path || '$', ...(redacted ? { Policy: 'redacted' } : { ...(left === undefined ? {} : { SourceValue: JSON.stringify(left) }), ...(right === undefined ? {} : { TargetValue: JSON.stringify(right) }) }) };
      if (field.Path.length > 512 || [field.SourceValue, field.TargetValue].some(value => value !== undefined && Buffer.byteLength(value) > 10240)) { result.Truncated = true; return; }
      admit(field, fields, 100);
    };
    walk(source[name], target[name], '', 0);
    if (!differs) result.InSync++;
    else { result.Diverged++; if (name.length <= 256 && result.Items.Diverged.length < 1000) result.Items.Diverged.push({ Name: name, Fields: fields }); else result.Truncated = true; }
  }
  return result;
}
