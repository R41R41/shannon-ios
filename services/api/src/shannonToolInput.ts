import type { ToolInputSchema } from './shannonTools.js';

/**
 * The input of one tool call, checked against the tool's schema (`shannonTools.ts`): an object with only the
 * listed fields, each of its type and within its bounds, and every required field present. Strings are kept as
 * written (a body keeps its lines); an empty optional string counts as absent, except where the tool reads it
 * (`pursuitId: ""` clears a shelf).
 */
export type ToolInput = Readonly<Record<string, string | number | boolean>>;

export function validToolInput(value: unknown, schema: ToolInputSchema): { input: ToolInput } | { problem: string } {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = value.trim() ? JSON.parse(value) : {}; } catch { return { problem: '入力がJSONとして読めない' }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: '入力がオブジェクトではない' };
  const input: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const property = Object.hasOwn(schema.properties, key) ? schema.properties[key]! : null;
    if (!property) return { problem: `知らない項目「${key.slice(0, 40)}」がある` };
    if (raw === null || raw === undefined) continue;
    if (property.type === 'string') {
      if (typeof raw !== 'string') return { problem: `「${key}」は文字列で書く` };
      if (property.maxLength !== undefined && raw.length > property.maxLength) return { problem: `「${key}」が長すぎる（${property.maxLength}字まで）` };
      if (property.minLength !== undefined && raw.trim().length < property.minLength) return { problem: `「${key}」が空` };
      if (property.enum && !property.enum.includes(raw)) return { problem: `「${key}」は ${property.enum.join('、')} のどれか` };
      input[key] = raw;
    } else if (property.type === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { problem: `「${key}」は整数で書く` };
      if (raw < property.minimum || raw > property.maximum) return { problem: `「${key}」は${property.minimum}〜${property.maximum}` };
      input[key] = raw;
    } else {
      if (typeof raw !== 'boolean') return { problem: `「${key}」は true か false` };
      input[key] = raw;
    }
  }
  const missing = schema.required.find(key => input[key] === undefined);
  if (missing) return { problem: `「${missing}」がない` };
  return { input: Object.freeze(input) };
}

export function stringInput(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberInput(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}
