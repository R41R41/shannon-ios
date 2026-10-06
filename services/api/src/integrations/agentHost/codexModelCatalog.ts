import type { AgentModelDescriptor, AgentReasoningEffort } from '../../agentTaskStore.js';
import type { CodexAppServerConnection } from './codexAppServerClient.js';

export async function codexModelCatalog(
  client: CodexAppServerConnection,
  fallbackModel?: string,
  fallbackEffort?: AgentReasoningEffort,
): Promise<readonly AgentModelDescriptor[]> {
  try {
    const models = new Map<string, AgentModelDescriptor>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const model of parseCodexModelCatalog(response)) models.set(model.id, model);
      cursor = nextCursor(response);
      if (!cursor) break;
    }
    if (models.size) return Object.freeze([...models.values()]);
  } catch {
    // A model catalog is advisory. Task execution remains available with the configured default.
  }
  if (!fallbackModel) return [];
  return [Object.freeze({
    id: fallbackModel,
    displayName: fallbackModel,
    supportedReasoningEfforts: Object.freeze(fallbackEffort ? [fallbackEffort] : []),
    ...(fallbackEffort ? { defaultReasoningEffort: fallbackEffort } : {}),
  })];
}

function nextCursor(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return stringValue((value as Record<string, unknown>).nextCursor);
}

export function parseCodexModelCatalog(value: unknown): readonly AgentModelDescriptor[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;
  const items = Array.isArray(object.data) ? object.data
    : Array.isArray(object.models) ? object.models
      : [];
  const result = items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const model = item as Record<string, unknown>;
    const id = stringValue(model.id) ?? stringValue(model.model);
    if (!id) return [];
    const rawEfforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts : Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts : [];
    const efforts = rawEfforts.flatMap(value => {
      const candidate = typeof value === 'string'
        ? value
        : value && typeof value === 'object' && !Array.isArray(value)
          ? stringValue((value as Record<string, unknown>).reasoningEffort)
            ?? stringValue((value as Record<string, unknown>).effort)
          : undefined;
      return isReasoningEffort(candidate) ? [candidate] : [];
    });
    const defaultEffort = stringValue(model.defaultReasoningEffort) ?? stringValue(model.defaultEffort);
    return [Object.freeze({
      id,
      displayName: stringValue(model.displayName) ?? stringValue(model.name) ?? id,
      ...(stringValue(model.description) ? { description: stringValue(model.description) } : {}),
      supportedReasoningEfforts: Object.freeze([...new Set(efforts)]),
      ...(isReasoningEffort(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}),
    })];
  });
  return Object.freeze(result);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra';
}
