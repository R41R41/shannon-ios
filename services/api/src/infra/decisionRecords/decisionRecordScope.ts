import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the model call, the tool calls and the body commands of one FCA step know of where they are (decision records): the task, the step, the
 * decision being made. Set once by `runFcaStep`; read where a request goes out and where a command goes to the body, so that those places need no
 * new parameters. `record`: only a body task (Minebot) is recorded; every other task's calls pass untouched.
 */
export interface DecisionScopeState {
  taskId: string;
  stepId: string;
  /** The step's number in its task (`fcaDecisionIndex`, the `d` of the `fca_decision_metrics` line); null until the runner has read it. */
  stepIndex: number | null;
  record: boolean;
  /** What the parts the decision stands on say of their versions (the body's connection and catalog); read when a request goes out. */
  versions?: () => Readonly<Record<string, unknown>>;
  /** The step's present decision: its operation id (`<step>:decision`, `<step>:decision2`…), its round, and the requests since the round began. */
  operationId: string | null;
  round: number;
  attempt: number;
  /** The newest decision request of the step (a summary's is never this): what the step's outcome notes are about. */
  lastDecisionId: string | null;
  /**
   * The results of commands the step put in front of the model (continue contract 8, `decision.reads`): the command and the words that stand in the history for it.
   * A request keeps the ones whose words are in its input (a result the history dropped is not read).
   */
  results: ResultMark[];
  /** The live state of the request being built (`raw` before the rewrite, `shown` after, what the rewrite left out): the next decision request completes the `live` row. */
  liveNote?: LiveNote;
}
export interface ResultMark { command: string; probe: string }
export interface LiveNote { raw: string; shown: string; dropped: { field: string; count: number; why: string }[] }
export interface DecisionCall { operationId: string; toolUseId: string; name: string }
interface Scope { state: DecisionScopeState; call?: DecisionCall }
const scopes = new AsyncLocalStorage<Scope>();

type ScopeInit = Pick<DecisionScopeState, 'taskId' | 'stepId' | 'record'> & { versions?: DecisionScopeState['versions'] };
export function withDecisionScope<T>(init: ScopeInit, work: () => T): T {
  const state: DecisionScopeState = { stepIndex: null, operationId: null, round: 0, attempt: 0, lastDecisionId: null, results: [], ...init };
  return scopes.run({ state }, work);
}
/** The calls of a decision's tools run inside this: a body command sent meanwhile is that call's. */
export function withDecisionCall<T>(call: DecisionCall, work: () => T): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ state: scope.state, call }, work) : work();
}
export function currentDecisionScope(): Scope | undefined { return scopes.getStore(); }
/** A decision of the step is about to be asked (its first request, or the round after the stretch's items ran). */
export function beginDecisionRound(operationId: string, round: number): void {
  const state = scopes.getStore()?.state;
  if (!state) return;
  state.operationId = operationId;
  state.round = round;
  state.attempt = 0;
  state.lastDecisionId = null;
}
export function setDecisionStepIndex(index: number): void {
  const state = scopes.getStore()?.state;
  if (state) state.stepIndex = index;
}
