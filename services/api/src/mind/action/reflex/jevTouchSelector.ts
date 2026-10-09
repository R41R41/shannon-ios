import { JEV_QUESTION_SETS, jevChoice, type JevChooser } from '../../../infra/models/jev/jevChoice.js';
import type { FcaTouchInput, FcaTouchSelector } from './fcaTouchPorts.js';

/** One optional supplementary gesture; the device already performed its immediate local touch reflex. */
export class JevTouchSelector implements FcaTouchSelector {
  constructor(private readonly jev: Pick<JevChooser, 'decide'>) {}
  async select(input: FcaTouchInput, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    const names = [...new Set(input.gestures)].filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u.test(name)).slice(0, 32);
    if (!names.length) return null;
    const candidates = Object.fromEntries(names.map((name, index) => [`g${index}`, `Registered avatar gesture: ${name}`]));
    const answer = await this.jev.decide({ scopeKey: input.scopeKey, surface: 'text', decision: 'tool_menu', sets: [JEV_QUESTION_SETS.fcaTouchReflex], signal,
      state: { touch: input.touch, audience: input.audience, toucher: 'unknown', posture: 'not_reported', emotion: input.emotion,
        priorStances: input.stances, immediateReflex: input.touch.reflex ?? 'not_reported' },
      questions: { gesture: { type: 'choice', instructions: 'Choose at most one supplementary bodily gesture for this contact, or none. The device has already made its immediate local reflex. Do not repeat that reflex, infer who touched from location/audience, prescribe acceptance from body part, or choose speech. Prior stances describe boundaries, not fixed permission. Only registered concrete candidates exist.',
        criteria: { none: 'No additional gesture; continue the existing reaction.', ...candidates } } },
      parse: answers => { if (Object.keys(answers).join(',') !== 'gesture') throw new Error('FCA_TOUCH_CHOICE');
        const key = jevChoice(answers, 'gesture', ['none', ...Object.keys(candidates)]); if (key === 'none') return null;
        return names[Number(key.slice(1))]!; }, fallback: () => null,
      traceAnswers: (choice, source) => ({ choice: choice === null ? 'none' : `g${names.indexOf(choice)}`, source }),
    });
    signal.throwIfAborted();
    if (answer.source !== 'jev') throw new Error('FCA_TOUCH_CHOICE_UNKNOWN');
    return answer.value;
  }
}
