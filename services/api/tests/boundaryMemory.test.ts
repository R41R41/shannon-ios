import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createInitialCompanionState, type CompanionStateSnapshot, type InnerNoteDraft, type InnerNoteReflectionFacts } from '@shannon/cognition';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingBody, feelingText, type FeelingPort } from '../src/mind/emotion/feelingPorts.js';
import { InnerNoteService } from '../src/mind/emotion/innerNoteService.js';
import type { InnerNoteReflector } from '../src/mind/emotion/innerNoteReflection.js';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';

/**
 * Boundary memory (Syzygy ADR-0013 D6, stage 3; `SHANNON_BOUNDARY_MEMORY`): a boundary she was told (「胸は嫌だって言わないと」) stays
 * `told` and is never worded as her own decision, until her inner note's reflection endorses it; forgetting the telling forgets both.
 */
const T0 = '2026-10-14T04:00:00.000Z';
const clean = (): CompanionStateSnapshot => createInitialCompanionState('owner', T0);
const forgetting = (ids: readonly string[]): CompanionStateSnapshot => ({ ...clean(), memoryControls: ids.map(memoryId => ({ memoryId, kind: 'experience' as const,
  status: 'forgotten' as const, pinned: false, updatedAt: T0, changeReason: 'owner' })) });
const draft: InnerNoteDraft = { text: { honne: '本音。', tatemae: '建て前。', reason: '理由。', plan: 'つもり。', bottom: '底。' }, shown: 'neutral', tell: 'none',
  intent: 'none', scale: 'ordinary', dayReason: null, untilMinutes: null, changeReason: null, routeSummary: 'Calm.', summary: null };

function setup(endorse: readonly string[]) {
  const clock = { at: T0 };
  let snapshot = clean();
  const { port } = composedFeeling({ database: new DatabaseSync(':memory:'), now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: null, turn: true,
    singleFace: false, days: { relationship: false, episodes: false, boundaries: true } });
  const handed: InnerNoteReflectionFacts[] = [];
  const reflector: InnerNoteReflector = { model: 'test', async reflect(request) {
    handed.push(request.facts);
    return { draft, usage: null, ...(request.facts.toldBoundaries?.length ? { endorsed: endorse } : {}) };
  } };
  const notes = new InnerNoteService({ store: new SQLiteInnerNoteStore(new DatabaseSync(':memory:')), reflector, state: { snapshot: () => snapshot },
    ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => clock.at, manual: true });
  notes.useBody({ partCounts: () => [], ...feelingBody.noteReader(() => port, () => snapshot) });
  return { port, notes, handed, clock, set: (next: CompanionStateSnapshot) => { snapshot = next; }, get: () => snapshot };
}

async function say(port: FeelingPort, words: string, at: string, snapshot: CompanionStateSnapshot, id: string): Promise<string> {
  const handle = feelingText.start(port, { scopeKey: 'owner', alone: true, surface: false, message: words, begun: { occurredAt: at, captured: snapshot } });
  const block = await feelingText.block(handle);
  feelingText.ended(handle, { at, message: words, reply: 'うん。', experienceId: id });
  return block;
}

const later = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

describe('a boundary she was told', () => {
  it('stays told in her next turn, and her reflection is asked whether it is hers', async () => {
    const { port, notes, handed } = setup([]);
    await say(port, '胸は嫌だって言わないとだめだよ', T0, clean(), 'told');
    const block = await say(port, 'ねえ', later(1), clean(), 'next');
    expect(block).toContain('胸: ライ氏に「嫌と言わないと」と言われて持った境界。まだボクが自分で決めたものではない');
    notes.turnEnded({ scopeKey: 'owner', surface: 'text', alone: true, at: later(2), userMessage: 'さっきはごめんね', reply: 'うん。', feeling: null });
    await notes.flush('owner');
    expect(handed.at(-1)!.toldBoundaries).toEqual([{ subject: 'chest', word: '胸' }]);
    expect(await say(port, 'ねえ', later(3), clean(), 'after')).toContain('まだボクが自分で決めたものではない');
  });

  it('becomes hers once her reflection endorses it, and both go when the telling is forgotten', async () => {
    const { port, notes, set } = setup(['chest']);
    await say(port, '胸は嫌だって言わないとだめだよ', T0, clean(), 'told');
    notes.turnEnded({ scopeKey: 'owner', surface: 'text', alone: true, at: later(2), userMessage: 'さっきはごめんね', reply: 'うん。', feeling: null });
    await notes.flush('owner');
    expect(await say(port, 'ねえ', later(3), clean(), 'after')).toContain('胸: ライ氏に言われて考え、ボクが自分のものにした境界');
    const forgot = forgetting(['told']);
    set(forgot);
    expect(await say(port, 'ねえ', later(4), forgot, 'later')).not.toContain('[ボクの境界]');
  });

  it('does not feed the touch judgment until she endorses it (owner, form 「入れない」; review L2)', async () => {
    const told = setup(['chest']);
    await say(told.port, '胸は嫌だって言わないとだめだよ', T0, clean(), 'told');
    expect(feelingBody.lines(told.port, 'owner', 'owner', later(1), clean())).not.toContain('境界');
    told.notes.turnEnded({ scopeKey: 'owner', surface: 'text', alone: true, at: later(2), userMessage: 'さっきはごめんね', reply: 'うん。', feeling: null });
    await told.notes.flush('owner');
    expect(feelingBody.lines(told.port, 'owner', 'owner', later(3), clean())).toContain('ボクが自分のものにした境界');
  });

  it('is not read while boundary memory is off', async () => {
    const { port } = composedFeelingOff();
    await say(port, '胸は嫌だって言わないとだめだよ', T0, clean(), 'told');
    expect(await say(port, 'ねえ', later(1), clean(), 'next')).not.toContain('[ボクの境界]');
  });
});

function composedFeelingOff() {
  return composedFeeling({ database: new DatabaseSync(':memory:'), now: () => T0, timeZone: 'Asia/Tokyo', chooser: null, turn: true, singleFace: false });
}
