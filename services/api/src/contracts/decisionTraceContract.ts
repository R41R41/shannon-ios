/**
 * The closed vocabulary of a decision trace (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`): what a trace may
 * hold and the check every write goes through. No store: the parts that write a trace (the voice gateway's wrapper, her own
 * time's thinking step) name these types and are handed a writer function.
 */
export const TRACE_SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;
export const TRACE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u;

/** `text` from Syzygy ADR-0008 stage 2 (the tool menu and the difficulty of a text turn). */
export const TRACE_SURFACES = ['voice', 'autonomy', 'text'] as const;
/**
 * Stage 2 adds `tool_menu` (Jev's choice of the tools a turn offers the model), `difficulty` (Jev's difficulty questions and
 * the tier the policy chose) and `recall_beam` (one beam search of tree recall), `docs/skill-and-routing-contract.md`. Syzygy ADR-0013
 * stage 1 adds `feeling_turn` (her stance before a text reply).
 */
export const TRACE_DECISIONS = ['voice_route', 'autonomy_think', 'tool_menu', 'difficulty', 'recall_beam', 'feeling_turn', 'addressed', 'mini_pose'] as const;
export const TRACE_DECIDERS = ['jev', 'openai', 'anthropic', 'local', 'model'] as const;
export const TRACE_OUTCOMES = ['ok', 'timeout', 'error', 'fallback'] as const;

/** An answer: a closed symbol, a boolean, a finite number, or a list of closed symbols. */
export type TraceAnswer = string | boolean | number | readonly string[];

export interface DecisionTraceDraft {
  surface: typeof TRACE_SURFACES[number];
  decision: typeof TRACE_DECISIONS[number];
  decider: typeof TRACE_DECIDERS[number];
  model: string;
  questions: number | null;
  contextChars: number | null;
  latencyMs: number;
  outcome: typeof TRACE_OUTCOMES[number];
  fallbackDecider: typeof TRACE_DECIDERS[number] | null;
  answers: Readonly<Record<string, TraceAnswer>>;
  /** Null when the cost is not known (Jev's price unset). */
  costUsd: number | null;
  relatedId: string | null;
  at: string;
}

export interface StoredDecisionTrace extends DecisionTraceDraft { traceId: string; scopeKey: string }

/** What a part is handed to write one trace: a function, never the store. */
export type DecisionTraceWriter = (scopeKey: string, draft: DecisionTraceDraft) => void;

/** The draft as it will be stored, or an error when anything in it is not a closed value. */
export function checkedTrace(draft: DecisionTraceDraft): DecisionTraceDraft {
  const closed = (value: string, allowed: readonly string[]) => allowed.includes(value);
  if (!closed(draft.surface, TRACE_SURFACES) || !closed(draft.decision, TRACE_DECISIONS) || !closed(draft.decider, TRACE_DECIDERS)
    || !closed(draft.outcome, TRACE_OUTCOMES) || (draft.fallbackDecider !== null && !closed(draft.fallbackDecider, TRACE_DECIDERS))) throw new Error('DECISION_TRACE_VOCABULARY');
  if (!TRACE_SYMBOL.test(draft.model)) throw new Error('DECISION_TRACE_SYMBOL');
  if (draft.relatedId !== null && !TRACE_IDENTIFIER.test(draft.relatedId)) throw new Error('DECISION_TRACE_IDENTIFIER');
  if (!Number.isFinite(Date.parse(draft.at))) throw new Error('DECISION_TRACE_TIME');
  const count = (value: number | null) => (value === null ? null : Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  const answers: Record<string, TraceAnswer> = {};
  for (const [name, value] of Object.entries(draft.answers)) {
    if (!TRACE_SYMBOL.test(name)) throw new Error('DECISION_TRACE_ANSWER');
    if (typeof value === 'boolean') answers[name] = value;
    else if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('DECISION_TRACE_ANSWER'); answers[name] = Math.round(value * 1e4) / 1e4; }
    else if (typeof value === 'string') { if (!TRACE_SYMBOL.test(value)) throw new Error('DECISION_TRACE_ANSWER'); answers[name] = value; }
    else if (Array.isArray(value) && value.every(item => typeof item === 'string' && TRACE_SYMBOL.test(item))) answers[name] = [...value].slice(0, 32);
    else throw new Error('DECISION_TRACE_ANSWER');
  }
  const cost = draft.costUsd === null || !Number.isFinite(draft.costUsd) || draft.costUsd < 0 ? null : Math.round(draft.costUsd * 1e9) / 1e9;
  return {
    ...draft, questions: count(draft.questions), contextChars: count(draft.contextChars), latencyMs: count(draft.latencyMs) ?? 0, answers,
    costUsd: draft.costUsd === null ? null : cost, at: new Date(Date.parse(draft.at)).toISOString(),
  };
}
