/** Pin only the intentional optional search-schema additions in old byte proofs. Native schema tests cover today's schema. */
export function historicalSearchRequest(body: string): string {
  const parsed = JSON.parse(body) as { tools?: { name?: string; parameters?: { properties?: Record<string, unknown> } }[] };
  const additions: Record<string, readonly string[]> = {
    study_search: ['match', 'after', 'before', 'offset', 'order', 'field', 'kind', 'status'],
    schedule_upcoming: ['query', 'kind', 'after', 'before', 'offset', 'limit'],
    memory_search: ['match', 'after', 'before', 'offset', 'order', 'kind', 'limit'],
  };
  for (const tool of parsed.tools ?? []) {
    const properties = tool.parameters?.properties;
    if (properties) for (const key of additions[tool.name ?? ''] ?? []) delete properties[key];
  }
  return JSON.stringify(parsed);
}
