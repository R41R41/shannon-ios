import type Anthropic from '@anthropic-ai/sdk';
import type { FcaDecision } from '../../../mind/action/fca/fcaPorts.js';
import type { FcaAuxiliaryResult } from '../../../mind/action/fca/fcaEvidencePorts.js';

/** The control tools of the native request (`CONTROL_TOOLS` of `anthropicFcaModel.ts`, by name): a wait and a completion. */
const CONTROL_NAMES: readonly string[] = ['fca_wait', 'fca_complete'];
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/**
 * What a model is told of a control call that came with another one (run 41, 2026-10-27: a completion turned back for want of evidence was asked again beside
 * a tool, and `FCA_MODEL_CONTROL_MIXED` left the step unknown for 1.5 minutes). The tools run; a completion or a wait is taken only when it stands alone.
 */
export function setAsideNote(name: string, taken: 'tools' | 'wait' | 'complete'): string {
  const what = name === 'fca_complete' ? '完了' : '待ち';
  const how = taken === 'tools' ? 'ほかの道具だけを実行した。' : taken === 'wait' ? '待ちを受け付けた。' : '完了を受け付けた。';
  const next = name === 'fca_complete' ? 'まだ終わっていないなら続け、終わったと確かめられたら完了を単独で出す。' : '待つ必要が続くなら待ちを単独で出す。';
  return JSON.stringify({ received: false, note: what + 'は単独の呼び出しでだけ受け付ける（ほかの道具や、待ち・完了の片方と同時には出せない）。' + how + next });
}

/** The decision of a model's answer, with the control calls that were set aside (answered, not taken). */
export function decodeDecision(content: Anthropic.ContentBlock[], names: Map<string, string>, history: readonly Anthropic.MessageParam[],
  auxiliary?: string): { decision: FcaDecision; set_aside: Anthropic.ToolUseBlock[] } {
  if (!Array.isArray(content) || !content.length || content.some(block => !object(block))) throw new Error('FCA_MODEL_OUTPUT_INVALID');
  const allCalls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  const calls = allCalls.filter(call => call.name !== auxiliary);
  if (!calls.length) throw new Error('FCA_MODEL_DECISION_MISSING');
  const used = new Set(history.flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []));
  for (const call of allCalls) {
    if (!nonempty(call.id) || used.has(call.id) || !object(call.input)) throw new Error('FCA_MODEL_CALL_INVALID');
    used.add(call.id);
  }
  const controls = calls.filter(call => CONTROL_NAMES.includes(call.name));
  const others = calls.filter(call => !controls.includes(call));
  // Run 41: the tools win over a control beside them (what the model asked to be done is done, and it decides again with the results: a completion that stands
  // beside an action would end the task under the action); of two controls the wait wins (it ends nothing). The ones set aside are answered, never thrown.
  if (others.length) return { decision: toolsOf(others, names), set_aside: controls };
  if (controls.length) return controlDecision(controls);
  return { decision: toolsOf(calls, names), set_aside: [] };
}
/** A control that stands alone (or the wait of two controls): its summary must be one nonempty string, and the others are set aside. */
function controlDecision(controls: Anthropic.ToolUseBlock[]): { decision: FcaDecision; set_aside: Anthropic.ToolUseBlock[] } {
  const taken = controls.find(call => call.name === 'fca_wait') ?? controls[0]!;
  const value = object(taken.input)!;
  if (Object.keys(value).length !== 1 || !nonempty(value.summary) || value.summary.length > 2_000) throw new Error('FCA_MODEL_SUMMARY_INVALID');
  return { decision: { kind: taken.name === 'fca_wait' ? 'wait' : 'complete', summary: value.summary }, set_aside: controls.filter(call => call !== taken) };
}
function toolsOf(calls: Anthropic.ToolUseBlock[], names: Map<string, string>): FcaDecision {
  return { kind: 'tools', calls: calls.map(call => {
    const name = names.get(call.name);
    if (!name) throw new Error('FCA_MODEL_TOOL_NOT_OFFERED');
    return { id: call.id, name, input: call.input };
  }) };
}

/**
 * The messages a decision adds to the replay: the model's answer, and for a control decision the user turn that answers its calls (the one taken says it was
 * received, one set aside says why not). For tools the runner answers the calls; the controls set aside beside them are handed on in `auxiliaryResults`,
 * which it puts first among the results of the round.
 */
export function answeredTurn(parts: {
  turn: Anthropic.MessageParam[]; content: Anthropic.ContentBlock[]; decision: FcaDecision; setAside: Anthropic.ToolUseBlock[];
  context: { auxiliaryResults?: readonly FcaAuxiliaryResult[] };
  toolResults(results: readonly { id: string; text: string; ok: boolean }[]): Anthropic.MessageParam;
}): Anthropic.MessageParam[] {
  const { turn, content, decision, setAside, context } = parts;
  const appended: Anthropic.MessageParam[] = [...turn, { role: 'assistant', content }];
  const answered = setAside.map(block => ({ id: block.id, ok: false, text: setAsideNote(block.name, decision.kind) }));
  if (decision.kind === 'tools') {
    if (answered.length) context.auxiliaryResults = [...(context.auxiliaryResults ?? []), ...answered];
    return appended;
  }
  const name = decision.kind === 'wait' ? 'fca_wait' : 'fca_complete';
  const control = content.find(block => block.type === 'tool_use' && block.name === name) as Anthropic.ToolUseBlock;
  const received = { id: control.id, text: JSON.stringify({ received: true, requestedDecision: decision.kind }), ok: true };
  appended.push(parts.toolResults([...(context.auxiliaryResults ?? []), ...answered, received]));
  delete context.auxiliaryResults;
  return appended;
}
