import type { ShannonModelToolSession, ToolCallOutcome } from '../chatModelTools.js';
import { NOT_OFFERED } from '../chatModelToolStep.js';
import { providerToolName } from '../../../mind/tools/shannonTools.js';
import { TOOL_OPEN_PROVIDER_NAME } from '../../../mind/tools/shannonToolMenu.js';
import { TOOL_CALL_DEFINITION, TOOL_CALL_JSON_CHARACTERS, TOOL_CALL_PROVIDER_NAME } from './anthropicToolCapacity.js';

const INVALID = JSON.stringify({ ok: false, failure: 'invalid_input', retryable: false, text: '道具の名前とJSON入力を確認してください。実行していません。' });

/** One provider transport, retaining the original offer, gate, deadline, notes and per-call identity. */
export function bridgedAnthropicSession(base: ShannonModelToolSession, nativeNames: Set<string>): ShannonModelToolSession {
  const opened = new Set(base.definitions.filter(tool => tool.domain !== 'meta').map(tool => providerToolName(tool.name)));
  const allowed = new Map((base.menu?.offered ?? base.definitions).filter(tool => tool.domain !== 'meta').map(tool => [providerToolName(tool.name), tool]));
  const refusal = (name: string) => base.refuse?.(name) ?? NOT_OFFERED;
  const outcome = (output: string): ToolCallOutcome => ({ output, note: () => {} });
  const originalStart = (name: string, input: string, signal?: AbortSignal, milliseconds?: number) => base.start
    ? base.start(name, input, signal, milliseconds) : base.call(name, input, signal, milliseconds).then(outcome);
  const start: NonNullable<ShannonModelToolSession['start']> = async (name, input, signal, milliseconds) => {
    if (name !== TOOL_CALL_PROVIDER_NAME) return nativeNames.has(name) ? originalStart(name, input, signal, milliseconds) : outcome(refusal(name));
    let args: { name?: unknown; argumentsJson?: unknown };
    try {
      if (input.length > TOOL_CALL_JSON_CHARACTERS * 6 + 1_024) return outcome(INVALID);
      const value: unknown = JSON.parse(input);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'argumentsJson'].includes(key))) return outcome(INVALID);
      args = value;
    } catch { return outcome(INVALID); }
    if (typeof args.name !== 'string' || typeof args.argumentsJson !== 'string' || args.argumentsJson.length > TOOL_CALL_JSON_CHARACTERS) return outcome(INVALID);
    if (!allowed.has(args.name) || !opened.has(args.name)) return outcome(refusal(args.name));
    try {
      const value: unknown = JSON.parse(args.argumentsJson);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return outcome(INVALID);
    } catch { return outcome(INVALID); }
    // The original validator/gate checks the original object; the bridge never executes or grants authority itself.
    return originalStart(args.name, args.argumentsJson, signal, milliseconds);
  };
  return {
    get definitions() { return [...base.definitions.filter(tool => nativeNames.has(providerToolName(tool.name))), TOOL_CALL_DEFINITION]; },
    maximumCalls: base.maximumCalls, deadline: base.deadline, menu: base.menu,
    writesWithheld: base.writesWithheld, othersPresent: base.othersPresent, guestTurn: base.guestTurn, refuse: base.refuse,
    start,
    async call(name, input, signal, milliseconds) { const result = await start(name, input, signal, milliseconds); result.note(); return result.output; },
    meta(name, input) {
      const result = base.meta?.(name, input) ?? null;
      if (name !== TOOL_OPEN_PROVIDER_NAME || !result) return result;
      let target: unknown, ok: unknown;
      try { target = (JSON.parse(input) as { name?: unknown }).name; ok = (JSON.parse(result) as { ok?: unknown }).ok; } catch { return result; }
      if (ok !== true || typeof target !== 'string' || !allowed.has(target)) return result;
      opened.add(target);
      const tool = allowed.get(target)!;
      return JSON.stringify({ ok: true, text: '道具を開きました。次の呼び出しで通常の名前が提示されていればそれを使い、なければ tool_call を使ってください。',
        name: target, inputSchema: tool.input, definitionIsData: true, invocation: { tool: TOOL_CALL_PROVIDER_NAME, name: target, argumentsJson: '元の入力オブジェクトのJSON文字列' } });
    },
  };
}
