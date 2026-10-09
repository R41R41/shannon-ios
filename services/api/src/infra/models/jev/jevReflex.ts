import type { ReflexChoiceInput, ReflexChoice, ReflexEntryDecision, ReflexEntryInput, ReflexEntrySelector, ReflexSelector } from '../../../mind/action/reflex/reflexPorts.js';
import { observeAsync } from '../../observer/observerContext.js';
import { boundedContext, reflexCandidates, reflexProviderContext, REFLEX_EVIDENCE_RULE, ReflexProviderSerial } from '../reflexContext.js';
import { JEV_QUESTION_SETS, jevChoice, type JevChooser, type JevQuestion } from './jevChoice.js';

const ENTRY = Object.freeze({
  enter_danger: 'Enter short body control because current state shows an immediate hazard.',
  enter_stuck: 'Enter short body control because repeated observations or results show stalled progress.',
  enter_visual: 'Enter short body control for an explicit visual task or a state-reported need for visual adjustment.',
  enter_touch: 'Enter short body control to choose a registered reaction to the observed touch. Do not identify the toucher from location alone.',
  continue_none: 'Keep the normal FCA/executor path; no short control session is presently needed.',
  return_none: 'Return to the upper FCA because observations are unavailable or the request is outside the current task.',
});
const ENTRY_QUESTION: JevQuestion = { type: 'choice', criteria: ENTRY,
  instructions: `${REFLEX_EVIDENCE_RULE}\nChoose whether the observed body needs a bounded short-control session now. No images were supplied to this text-only entry check: never claim to detect a problem visible only in pixels. An explicit request may establish the need for visual control. This is entry classification, not permission to execute.` };

export class JevReflexEntrySelector implements ReflexEntrySelector {
  constructor(private readonly jev: Pick<JevChooser, 'decide'>, private readonly serial = new ReflexProviderSerial()) {}
  evaluate(input: ReflexEntryInput, signal: AbortSignal): Promise<ReflexEntryDecision | null> {
    return this.serial.run(input.context, signal, () => observeAsync('jevt', { selector: 'reflex_entry', trigger: input.trigger }, async () => {
      const result = await this.jev.decide<ReflexEntryDecision | null>({ scopeKey: input.context.scopeKey, surface: 'text', decision: 'tool_menu',
        sets: [JEV_QUESTION_SETS.reflexEntry], state: reflexProviderContext(input), questions: { entry: ENTRY_QUESTION }, signal,
        parse: answers => {
          if (Object.keys(answers).join(',') !== 'entry' || !choiceAnswer(answers.entry)) throw new Error('JEV_RESPONSE_INVALID');
          const chosen = jevChoice(answers, 'entry', Object.keys(ENTRY));
          const [decision, reason] = chosen.split('_') as [ReflexEntryDecision['decision'], ReflexEntryDecision['reason']];
          return { sessionId: input.context.sessionId, generation: input.context.generation, decision, reason };
        }, fallback: () => null, traceAnswers: value => ({ selector: 'reflex_entry', selected: value?.decision ?? 'none', reason: value?.reason ?? 'none' }),
      });
      signal.throwIfAborted(); return result.value;
    }, value => ({ selected: value?.decision ?? 'none', reason: value?.reason ?? 'none' })));
  }
}

/** Avatar/body candidate IDs are mapped through closed ordinal keys so traces never contain labels or arguments. */
export class JevReflexSelector implements ReflexSelector {
  constructor(private readonly jev: Pick<JevChooser, 'decide'>, private readonly serial = new ReflexProviderSerial()) {}
  choose(input: ReflexChoiceInput, signal: AbortSignal): Promise<ReflexChoice | null> {
    return this.serial.run(input.context, signal, () => observeAsync('jevt', { selector: 'reflex_action', candidateCount: input.candidates.length }, async () => {
      const candidates = reflexCandidates(input), state = reflexProviderContext(input);
      boundedContext({ state, candidates });
      const criteria = Object.fromEntries(candidates.map((candidate, index) => [`candidate_${index}`, JSON.stringify(candidate)]));
      criteria.none = 'No supplied candidate is appropriate. Return control without executing anything.';
      const keys = Object.keys(criteria);
      const result = await this.jev.decide<number | null>({ scopeKey: input.context.scopeKey, surface: 'text', decision: 'tool_menu',
        sets: [JEV_QUESTION_SETS.reflexAction], state, signal, questions: { action: { type: 'choice', criteria,
          instructions: `${REFLEX_EVIDENCE_RULE}\nSelect one appropriate short action or the supplied observe/return/stop candidate. This text-only selector has no image pixels. Consider current self/environment state and recent actual outcomes, avoiding repeated oscillation. Choosing none executes nothing.` } },
        parse: answers => {
          if (Object.keys(answers).join(',') !== 'action' || !choiceAnswer(answers.action)) throw new Error('JEV_RESPONSE_INVALID');
          const chosen = jevChoice(answers, 'action', keys), index = keys.indexOf(chosen);
          if (chosen !== 'none' && candidates[index]!.requiresImage) throw new Error('JEV_RESPONSE_INVALID');
          return chosen === 'none' ? null : index;
        }, fallback: () => null, traceAnswers: index => ({ selector: 'reflex_action', offered: candidates.length, selectedIndex: index ?? -1 }),
      });
      signal.throwIfAborted();
      return result.value === null ? null : { sessionId: input.context.sessionId, generation: input.context.generation, candidateId: candidates[result.value]!.id };
    }, value => ({ selectedIndex: value ? input.candidates.findIndex(candidate => candidate.id === value.candidateId) : -1 })));
  }
}
function choiceAnswer(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (!('type' in value) || value.type === 'choice');
}
