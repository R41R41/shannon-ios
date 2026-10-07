import type { IdentityChooser } from '../../../mind/memory/memoryPorts.js';
import { JevChoiceClient, jevAnswers, jevNoul, type JevQuestion } from './jevChoice.js';

/**
 * Identity tier 4 through Jev (Syzygy ADR-0008 stage 3, step F6, `docs/mind-workspace-contract.md`): for a newly met name and at
 * most 15 remembered people (never the owner), one probability per candidate that it is the same person and one that it is a new
 * person. The memory writer follows it only in the 0.9/0.1 band (`identityChoice`), and only to suggest: the owner merges. It
 * runs in the background (the writer), never on a turn. The question set is fixed and versioned (`identity.v1`, English).
 */
export const JEV_IDENTITY_SET = 'identity.v1';

const SAME: JevQuestion['instructions'] = 'The state gives a name Shannon has just heard (newName) and the names under which she remembers one person (candidate). Is newName most likely the same person as that candidate? Spelling variants, nicknames and transliterations of one name count as the same person; a merely similar or common name does not.';
const NEW: JevQuestion['instructions'] = 'The state gives a name Shannon has just heard (newName) and the people she remembers (menu). Is newName most likely a person who is none of them?';

export class JevIdentityChooser implements IdentityChooser {
  constructor(private readonly client: JevChoiceClient) {}

  async probabilities(_scopeKey: string, input: { name: string; menu: readonly { key: string; names: readonly string[] }[] }): Promise<Readonly<Record<string, number>> | null> {
    const questions: Record<string, JevQuestion> = Object.fromEntries([
      ...input.menu.map(item => [`same__${item.key}`, { type: 'noul' as const, instructions: `${SAME} The candidate is ${item.key}.`,
        criteria: { yes: 'the same person', no: 'a different person' } }]),
      ['new_person', { type: 'noul' as const, instructions: NEW, criteria: { yes: 'none of them', no: 'one of them' } }],
    ]);
    const body = await this.client.ask({ set: JEV_IDENTITY_SET, newName: input.name, menu: Object.fromEntries(input.menu.map(item => [item.key, item.names])) }, questions);
    const answers = jevAnswers(body);
    return Object.freeze({
      ...Object.fromEntries(input.menu.map(item => [item.key, jevNoul(answers, `same__${item.key}`)])),
      new_person: jevNoul(answers, 'new_person'),
    });
  }
}

/** Tier 4's chooser while `TYPESAFE_API_KEY` is set (`SHANNON_IDENTITY_JEV_TIMEOUT_MS`, default 3000 in the background); null otherwise. */
export function configuredJevIdentityChooser(environment: Readonly<Record<string, string | undefined>>, fetcher?: typeof fetch): IdentityChooser | null {
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const timeout = Number(environment.SHANNON_IDENTITY_JEV_TIMEOUT_MS?.trim());
  return new JevIdentityChooser(new JevChoiceClient({ apiKey, timeoutMilliseconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(10_000, timeout) : 3_000,
    ...(fetcher ? { fetcher } : {}) }));
}
