import { createHash } from 'node:crypto';
import type { FcaExternalTools, FcaToolDefinition } from './fcaPorts.js';
import type { FcaGoalBinding, FcaGoalCondition, FcaGoalVerification, FcaProgress, FcaProgressHooks } from './fcaProgressPorts.js';
import { providerToolName, toolFailure, toolOk } from '../../tools/toolRegistryPorts.js';

const empty = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]): FcaToolDefinition => ({
  name, description, input: empty, nativeInputSchema: { type: 'object', properties, required, additionalProperties: false },
  domain: 'task_runtime', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
});
const conditionSchema = { type: 'object', properties: {
  id: { type: 'string', minLength: 1, maxLength: 80 }, tool: { type: 'string', minLength: 1, maxLength: 80 },
  input: { type: 'object' }, path: { type: 'string', maxLength: 240 }, operator: { type: 'string', enum: ['eq', 'gte', 'contains', 'exists'] },
  expected: { type: ['string', 'number', 'boolean', 'null'] },
}, required: ['id', 'tool', 'input', 'path', 'operator'], additionalProperties: false };
export const FCA_PROGRESS_TOOLS: readonly FcaToolDefinition[] = [
  definition('goal.set_conditions', [
    '達成を確かめる観測条件の案を保存する。条件の案だけで元の目的の達成を証明できるわけではない。',
    'tool には、いま提示されている無料の読み取り道具の名前を道具一覧と同じ表記で書く（書き込みや有料の道具は使えない）。',
    'path は結果 JSON のドット区切り、空なら結果全文。operator は eq・gte・contains・exists。',
    '例: {"id":"saved","tool":"<読み取り道具の名前>","input":{},"path":"status","operator":"eq","expected":"done"}。',
    'progress に binding があれば、その条件は元の依頼に結び付いた検証としてすでに保存されているので、出し直さなくてよい。',
  ].join(''), { conditions: { type: 'array', minItems: 1, maxItems: 8, items: conditionSchema } }, ['conditions']),
  definition('goal.verify', '保存された達成条件を新しい観測で検証する。操作の受付だけを成功の証拠にしない。目的との対応が信頼された条件だけが verified になる。', {}, []),
  definition('task.replan', '結果が分かっている失敗の操作 id に結びつけて次の進め方を保存する。最大3回。結果不明の書き込みや有料呼び出しを再送する許可にはならない。', {
    failureOperationId: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', minLength: 1, maxLength: 1000 },
    nextSteps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 500 } },
  }, ['failureOperationId', 'summary', 'nextSteps']),
];
/** The fixed words of `requireConditions` in the progress she reads. */
export const FCA_CONDITIONS_REQUIRED = '完了にするには、goal.set_conditions で依頼の達成を示す観測の条件を置き、それが新しい観測で通ることが要る'
  + '（例: tool=minecraft.observe、path は空、operator=contains、expected="\"name\":\"diamond_pickaxe\""）。'
  + '条件が無い・通らない完了は続きに戻り、置いた条件は消える。達成していないなら完了にせず、次の手を進める。';
/** State goes into the existing segment checkpoint transaction, never an independent task/memory writer. */
export function createFcaProgressTools(base: FcaExternalTools, options: {
  checkpoint?: unknown; binding?: FcaGoalBinding; permit(): Promise<void>;
  /**
   * With no binding, a completion is hers to report (`self_reported`) unless this is set: then it needs conditions of her own
   * (`goal.set_conditions`) that all pass on a new observation. A body task (Minecraft run 17, 2026-10-19: a garbled request bound to
   * no goal was closed as complete after 8 decisions with "the dragon is not defeated" in its own summary, and the body stood still
   * for 6.4 minutes) is held to what it can show.
   */
  requireConditions?: boolean;
  /** Domain-owned interruption, identical to an ordinary read's physical lifecycle signal. */
  observationSignal?(name: string, parent: AbortSignal): AbortSignal;
}): FcaExternalTools & { progress: FcaProgressHooks } {
  const prior = object(options.checkpoint)?.fcaProgress;
  const state: FcaProgress = prior === undefined ? { conditions: [], verification: null, failures: [], replans: [] }
    : JSON.parse(JSON.stringify(prior)) as FcaProgress;
  if (!validState(state)) throw new Error('FCA_PROGRESS_CHECKPOINT_INVALID');
  delete state.binding;
  const readable = () => base.definitions.filter(tool => tool.effect === 'read' && tool.cost === 'none');
  const eligible = (name: string) => readable().find(tool => tool.name === name);
  const binding = options.binding ? JSON.parse(JSON.stringify(options.binding)) as FcaGoalBinding : undefined;
  if (binding && (!text(binding.id, 160) || !validConditions(binding.conditions))) throw new Error('FCA_GOAL_BINDING_INVALID');
  if (state.verification?.bindingId !== (binding?.id ?? null)) state.verification = null;
  const checks = async (conditions: readonly FcaGoalCondition[], call: Parameters<FcaExternalTools['execute']>[0], label: string) => {
    const result = [];
    for (const condition of conditions) {
      await options.permit(); call.signal.throwIfAborted();
      const operationId = `${call.operationId}:verify:${label}:${condition.id}`;
      if (!eligible(condition.tool)) { result.push({ conditionId: condition.id, operationId, tool: condition.tool, passed: false, resultDigest: '', failure: 'not_offered' }); continue; }
      const signal = options.observationSignal?.(condition.tool, call.signal) ?? call.signal;
      if (signal.aborted) { result.push({ conditionId: condition.id, operationId, tool: condition.tool, passed: false, resultDigest: '', failure: 'observation_interrupted' }); continue; }
      // The real executor retains audience, sources, resource leases and original read receipts.
      const observed = await base.execute({ ...call, signal, name: condition.tool, input: condition.input, operationId });
      await options.permit(); call.signal.throwIfAborted();
      result.push({ conditionId: condition.id, operationId, tool: condition.tool, passed: !signal.aborted && observed.ok && matches(condition, observed.text),
        resultDigest: createHash('sha256').update(observed.text).digest('hex'), ...(signal.aborted ? { failure: 'observation_interrupted' } : !observed.ok ? { failure: observed.failure ?? 'failed' } : {}) });
    }
    return result;
  };
  const verify = async (call: Parameters<FcaExternalTools['execute']>[0]): Promise<FcaGoalVerification> => {
    const trusted = binding ? await checks(binding.conditions, call, 'bound') : [];
    const suggested = await checks(state.conditions, call, 'suggested');
    const shown = suggested.length > 0 && suggested.every(check => check.passed);
    const status = binding ? trusted.every(check => check.passed) ? 'verified' : 'not_verified'
      : options.requireConditions && !shown ? 'not_verified' : 'self_reported';
    const verification: FcaGoalVerification = { status,
      bindingId: binding?.id ?? null, checks: trusted, suggestedChecks: suggested };
    state.verification = verification; return verification;
  };
  /**
   * The model names tools as its menu shows them (the provider form, `mc_goal-evidence` for `mc.goal-evidence`; Minebot lane run 1,
   * 2026-10-14: every condition was refused for that alone). A name is taken in either form and stored as the registry name; a
   * refusal says which condition failed and which free reads there are.
   */
  const setConditions = (input: Record<string, unknown>) => {
    const conditions = Array.isArray(input.conditions) ? input.conditions.map(resolvedCondition) : input.conditions;
    const unknown = Array.isArray(conditions) ? conditions.flatMap(row => object(row) && !eligible(String(object(row)!.tool)) ? [String(object(row)!.id)] : []) : [];
    if (Object.keys(input).length !== 1 || !validConditions(conditions) || unknown.length) return conditionRefusal(unknown);
    state.conditions = JSON.parse(JSON.stringify(conditions)) as FcaGoalCondition[];
    state.verification = null;
    return toolOk(JSON.stringify({ accepted: true, authority: 'suggested', conditions: state.conditions }));
  };
  const resolvedCondition = (value: unknown) => {
    const row = object(value);
    if (!row || typeof row.tool !== 'string' || eligible(row.tool)) return value;
    const matches = readable().filter(tool => providerToolName(tool.name) === row.tool);
    return matches.length === 1 ? { ...row, tool: matches[0]!.name } : value;
  };
  const conditionRefusal = (unknown: readonly string[]) => {
    const names = readable().map(tool => providerToolName(tool.name));
    const offered = names.length ? `使える無料の読み取り道具: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ' ほか' : ''}。` : '無料の読み取り道具が提示されていません。';
    const which = unknown.length ? `条件 ${unknown.slice(0, 8).join(', ')} の tool は無料の読み取り道具ではありません。` : '条件の形が合いません（id・tool・input・path・operator、exists 以外は expected）。';
    return toolFailure('invalid_input', `${which}${offered}`, { retryable: false });
  };
  const progress: FcaProgressHooks = {
    context: () => JSON.parse(JSON.stringify({ ...state, ...(binding ? { binding } : {}),
      ...(!binding && options.requireConditions ? { completionRule: FCA_CONDITIONS_REQUIRED } : {}) })) as FcaProgress,
    observed(operationId, name, result) {
      if (!result.ok && !FCA_PROGRESS_TOOLS.some(tool => tool.name === name)) {
        state.failures = [...state.failures, { operationId, name, failure: result.failure ?? 'failed', retryable: result.retryable }].slice(-16);
        state.verification = null;
      }
    },
    async verifyCompletion(call, permit) {
      await permit();
      const result = await verify(call);
      // A completion turned back clears her conditions: the next one is shown by conditions set for it, not by an old one still true.
      if (!binding && options.requireConditions && result.status === 'not_verified') state.conditions = [];
      await permit();
      return result;
    },
  };
  return { ...base, definitions: [...base.definitions, ...FCA_PROGRESS_TOOLS], progress,
    checkpoint: () => ({ ...base.checkpoint?.(), fcaProgress: state }),
    async execute(call) {
      if (!FCA_PROGRESS_TOOLS.some(tool => tool.name === call.name)) return base.execute(call);
      await options.permit(); call.signal.throwIfAborted();
      const input = object(call.input);
      if (!input) return toolFailure('invalid_input', '引数の形式が合いません。', { retryable: false });
      if (call.name === 'goal.set_conditions') return setConditions(input);
      if (call.name === 'goal.verify') {
        if (Object.keys(input).length) return toolFailure('invalid_input', '検証に引数は不要です。', { retryable: false });
        return toolOk(JSON.stringify(await verify(call)));
      }
      if (Object.keys(input).sort().join() !== 'failureOperationId,nextSteps,summary' || !text(input.failureOperationId, 240) || !text(input.summary, 1000)
        || !Array.isArray(input.nextSteps) || input.nextSteps.length < 1 || input.nextSteps.length > 8 || input.nextSteps.some(item => !text(item, 500))) return toolFailure('invalid_input', '失敗の操作 id と具体的な次の進め方が必要です。', { retryable: false });
      if (!state.failures.some(failure => failure.operationId === input.failureOperationId)) return toolFailure('refused', '結果の分かっている失敗だけを再計画の根拠にできます。', { refusal: { why: '失敗の観測がありません。', wouldWork: '元の操作の結果を確認してください。' } });
      if (state.replans.length >= 3) return toolFailure('limit', '再計画の上限に達しました。依存や条件を確認して待機してください。', { retryable: false });
      state.replans = [...state.replans, { failureOperationId: input.failureOperationId, summary: input.summary, nextSteps: input.nextSteps as string[] }];
      return toolOk(JSON.stringify({ accepted: true, replan: state.replans.at(-1), automaticReplay: false }));
    },
  };
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum; }
function validConditions(value: unknown): value is FcaGoalCondition[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && new Set(value.map(item => object(item)?.id)).size === value.length && value.every(item => {
    const row = object(item); if (!row || Object.keys(row).some(key => !['id', 'tool', 'input', 'path', 'operator', 'expected'].includes(key))) return false;
    return text(row.id, 80) && /^[a-zA-Z0-9_-]+$/u.test(row.id) && text(row.tool, 80) && object(row.input) && JSON.stringify(row.input).length <= 4000
      && typeof row.path === 'string' && row.path.length <= 240 && !row.path.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))
      && ['eq', 'gte', 'contains', 'exists'].includes(String(row.operator))
      && (row.operator === 'exists' || Object.hasOwn(row, 'expected'))
      && (!Object.hasOwn(row, 'expected') || row.expected === null || ['string', 'number', 'boolean'].includes(typeof row.expected))
      && (typeof row.expected !== 'string' || row.expected.length <= 2000) && (typeof row.expected !== 'number' || Number.isFinite(row.expected));
  });
}
function validState(state: FcaProgress): boolean {
  return Boolean(object(state)) && (state.verification === null || validVerification(state.verification)) && Array.isArray(state.conditions) && (!state.conditions.length || validConditions(state.conditions))
    && Array.isArray(state.failures) && state.failures.length <= 16 && state.failures.every(row => text(row.operationId, 240) && text(row.name, 80) && text(row.failure, 80) && typeof row.retryable === 'boolean')
    && Array.isArray(state.replans) && state.replans.length <= 3 && state.replans.every(row => text(row.failureOperationId, 240) && text(row.summary, 1000) && Array.isArray(row.nextSteps) && row.nextSteps.length <= 8 && row.nextSteps.every((item: unknown) => text(item, 500)));
}
function matches(condition: FcaGoalCondition, raw: string): boolean {
  let value: unknown = raw;
  if (condition.path) {
    try { value = JSON.parse(raw); } catch { return false; }
    for (const key of condition.path.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, unknown>)[key];
    }
  }
  if (condition.operator === 'exists') return value !== null && value !== undefined;
  if (condition.operator === 'eq') return value === condition.expected;
  if (condition.operator === 'gte') return typeof value === 'number' && typeof condition.expected === 'number' && value >= condition.expected;
  return (typeof value === 'string' && typeof condition.expected === 'string' && value.includes(condition.expected))
    || (Array.isArray(value) && value.includes(condition.expected));
}

function validVerification(value: FcaGoalVerification): boolean {
  const validCheck = (check: unknown) => {
    const row = object(check);
    return Boolean(row) && text(row!.conditionId, 80) && text(row!.operationId, 500) && text(row!.tool, 80) && typeof row!.passed === 'boolean'
      && typeof row!.resultDigest === 'string' && (row!.resultDigest === '' || /^[a-f0-9]{64}$/u.test(row!.resultDigest))
      && (row!.failure === undefined || text(row!.failure, 80));
  };
  return Boolean(object(value)) && ['verified', 'not_verified', 'self_reported'].includes(value.status)
    && (value.bindingId === null || text(value.bindingId, 160)) && Array.isArray(value.checks) && value.checks.length <= 8 && value.checks.every(validCheck)
    && Array.isArray(value.suggestedChecks) && value.suggestedChecks.length <= 8 && value.suggestedChecks.every(validCheck);
}
