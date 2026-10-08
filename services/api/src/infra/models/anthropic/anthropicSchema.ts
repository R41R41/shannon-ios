/** A JSON schema in the subset structured outputs supports: nullable types as `anyOf`, length and size limits in words. */
export function structuredSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(structuredSchema);
  if (!node || typeof node !== 'object') return node;
  const { type, minItems, maxItems, minLength, maxLength, minimum, maximum, ...rest } = node as Record<string, unknown>;
  const limits = [minItems !== undefined || maxItems !== undefined ? `${minItems ?? 0}〜${maxItems ?? ''}件` : '',
    maxLength !== undefined ? `${maxLength}字まで` : '', minimum !== undefined || maximum !== undefined ? `${minimum ?? ''}〜${maximum ?? ''}` : ''].filter(Boolean).join('、');
  const mapped: Record<string, unknown> = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key,
    key === 'properties' && value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, structuredSchema(child)])) : structuredSchema(value)]));
  if (limits) mapped.description = `${typeof mapped.description === 'string' ? mapped.description : ''}（${limits}）`;
  void minLength; // a minimum length is not said: the schema keeps only what it can hold
  if (Array.isArray(type)) {
    const { description, ...shape } = mapped;
    return { ...(description !== undefined ? { description } : {}), anyOf: type.map(item => (item === 'null' ? { type: 'null' } : { ...shape, type: item })) };
  }
  return type === undefined ? mapped : { type, ...mapped };
}
