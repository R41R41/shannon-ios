import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_AUDIENCE,
  UNKNOWN_GUEST_PRESENCE,
  memoryEvidenceCounters,
  withoutMemoryEvidenceCache,
  type CompanionStateSnapshot,
  type MemoryAudience,
} from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { MemoryWithholding, visibleConversationHistory } from '../src/mind/memory/memoryVisibility.js';
import { DisclosureGate } from '../src/mind/inhibition/disclosurePorts.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';

/**
 * 2026-10-14: every voice and text turn logged `slow deterministic context ... visible=500~600ms`: with one forgotten item, each
 * remembered turn was compared again with every withheld item's evidence. The verdicts are now remembered under the exact withheld
 * evidence (`packages/cognition/src/memoryEvidence.ts`). These tests hold the verdicts to the ones gathered afresh, step by step
 * through forgetting, restoring, correcting, rejecting, an audience switch, new memories and two scopes. Synthetic data only.
 */
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const THREADS = ['thread-0', 'thread-1', 'thread-2'];
const unrelated = ['Xcodeのビルドが通らない', '写真アプリの整理をしたい', '週末の散歩コースを考えて', '料理の献立を考えて'];

function build(scopes: readonly string[] = ['owner']) {
  const world = memoryWorld(); closes.push(world.close);
  const say = (scope: string, user: string, reply: string, extra: Record<string, unknown> = {}) => {
    world.advance(60_000);
    return world.store.appendTurn(scope, THREADS[Math.floor(world.clock.at / 60_000) % THREADS.length]!, user, reply, world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, ...extra });
  };
  const learn = (scope: string, user: string, reply: string) => {
    const turn = say(scope, user, reply);
    new TurnRefinementProcessor(world.store, world.store).process(scope, turn.userMessage, turn.id, turn.observedAt);
    return turn;
  };
  const facts: Record<string, { tea: string; cat: string; teaTurn: string; catTurn: string }> = {};
  for (const scope of scopes) {
    for (let round = 0; round < 6; round += 1) for (const line of unrelated) say(scope, `${line}（${round}）`, `${line}ですね、一緒に見ます（${round}）。`);
    const teaTurn = learn(scope, '私は紅茶が好き。', '紅茶が好きなんですね。').id;
    const catTurn = learn(scope, '私は猫が好き。', '猫が好きなんですね。').id;
    const snapshot = world.store.snapshot(scope);
    const tea = snapshot.userFacts.find(fact => fact.statement.includes('紅茶'))!.id;
    const cat = snapshot.userFacts.find(fact => fact.statement.includes('猫'))!.id;
    say(scope, 'おすすめの飲み物は？', 'ライ氏は紅茶が好きなので、ダージリンはどうですか。');
    say(scope, '午後に何か飲みたい', '温かい一杯を用意しましょうか。', { recalledMemoryIds: [tea] });
    say(scope, '昨日の話の続き', '私は紅茶が好き。と話してくれましたね。');
    for (const line of unrelated) say(scope, `${line}（続き）`, `${line}の続きですね。`);
    facts[scope] = { tea, cat, teaTurn, catTurn };
  }
  const service = new ShannonMemoryService(world.store, world.store, world.now);
  return { world, say, learn, facts, service };
}

type World = ReturnType<typeof build>['world'];

/** Everything a turn decides by the forgetting boundary and the audience gate, for one scope and audience. */
function verdicts(world: World, scope: string, present: MemoryAudience, snapshot: CompanionStateSnapshot) {
  const candidates = world.store.experienceCandidates(scope);
  const gate = new DisclosureGate(present, snapshot, world.store, scope, candidates);
  const withholding = new MemoryWithholding(snapshot, world.store, scope, candidates);
  const visible = withholding.withReadSnapshot(() => candidates
    .filter(item => gate.allowsTurn(item) && !withholding.withholdsExperience(item)).map(item => item.id));
  const context = prepareTurnCognitiveContext(snapshot, world.store, { scopeKey: scope, message: '紅茶と猫とギターの話', occurredAt: world.now(),
    channel: 'text', present });
  return {
    visible,
    withheld: withholding.withheldExperiences().map(item => item.id),
    memories: context.memories.map(memory => `${memory.id} ${memory.summary}`),
    prompt: context.prompt,
    history: THREADS.flatMap(thread => visibleConversationHistory(snapshot, world.store, scope, thread, present).map(item => item.content)),
  };
}

/** The same answers with remembered verdicts (a stored, frozen state) and gathered afresh (a thawed copy, nothing remembered). */
function bothWays(world: World, scope: string, present: MemoryAudience) {
  const warm = verdicts(world, scope, present, world.store.snapshot(scope));
  const fresh = withoutMemoryEvidenceCache(() => verdicts(world, scope, present, structuredClone(world.store.snapshot(scope))));
  expect(warm).toEqual(fresh);
  return warm;
}

describe('remembered visibility verdicts equal fresh ones', () => {
  it('through forget, a second turn, an audience switch, correction, rejection, new memories and restore', () => {
    const { world, say, learn, facts, service } = build();
    const { tea, cat, teaTurn, catTurn } = facts.owner!;
    const steps: Record<string, ReturnType<typeof bothWays>> = {};
    const step = (name: string) => {
      for (const present of [OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE]) {
        const result = bothWays(world, 'owner', present);
        if (present === OWNER_AUDIENCE) steps[name] = result;
      }
      return steps[name]!;
    };
    // Something forgotten from the start keeps the heavy path active, as in production.
    service.mutate('owner', { memoryId: world.store.experienceCandidates('owner')[0]!.id, action: 'forget' });
    const start = step('start');
    expect(start.visible).toContain(teaTurn);
    expect(JSON.stringify(start.history)).toContain('紅茶');
    expect(JSON.stringify(start.memories)).toContain('紅茶');

    service.mutate('owner', { memoryId: tea, action: 'forget' });
    const forgotten = step('forgotten');
    // A verdict remembered while the item was usable is never served after the forget.
    expect(forgotten.visible).not.toContain(teaTurn);
    expect(JSON.stringify(forgotten.history)).not.toContain('紅茶');
    expect(JSON.stringify(forgotten.memories)).not.toContain('紅茶');
    expect(forgotten.prompt).not.toContain('紅茶');
    expect(forgotten.visible).toContain(catTurn);

    // The next turn: the state is read again (newer version, same memory) and nothing else changed.
    world.store.apply('owner', { type: 'emotion-adjusted', delta: { valence: 0.05 } });
    // Her feeling and the state's version are in the prompt; every verdict is the same.
    const { prompt: _secondPrompt, ...second } = step('second turn'), { prompt: _firstPrompt, ...first } = forgotten;
    expect(second).toEqual(first);

    service.mutate('owner', { memoryId: cat, action: 'correct', text: '私は犬が好き。' });
    const corrected = step('corrected');
    expect(corrected.visible).not.toContain(catTurn);
    expect(corrected.prompt).not.toContain('猫');

    service.mutate('owner', { memoryId: cat, action: 'restore' });
    service.mutate('owner', { memoryId: cat, action: 'reject' });
    expect(step('rejected').visible).not.toContain(catTurn);

    // New memories: a turn quoting the forgotten evidence, and a new fact.
    const quoting = say('owner', 'もう一度言うと、私は紅茶が好き。', '覚えておきます。').id;
    learn('owner', '私はギターが好き。', 'ギターが好きなんですね。');
    const added = step('new memories');
    expect(added.visible).not.toContain(quoting);
    expect(JSON.stringify(added.memories)).toContain('ギター');

    service.mutate('owner', { memoryId: tea, action: 'restore' });
    const restored = step('restored');
    expect(restored.visible).toContain(teaTurn);
    expect(restored.visible).toContain(quoting);
    expect(JSON.stringify(restored.history)).toContain('紅茶');

    // Forgetting a turn directly withholds that turn again at once.
    service.mutate('owner', { memoryId: teaTurn, action: 'forget' });
    expect(step('turn forgotten').visible).not.toContain(teaTurn);
  }, 120_000);

  it('keeps two scopes apart while the same texts are judged under each', () => {
    const { world, facts, service } = build(['owner', 'second']);
    service.mutate('owner', { memoryId: facts.owner!.tea, action: 'forget' });
    service.mutate('second', { memoryId: facts.second!.cat, action: 'forget' });
    for (let round = 0; round < 2; round += 1) {
      for (const present of [OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE]) {
        const owner = bothWays(world, 'owner', present), second = bothWays(world, 'second', present);
        expect(owner.visible).not.toContain(facts.owner!.teaTurn);
        expect(owner.visible).toContain(facts.owner!.catTurn);
        expect(second.visible).toContain(facts.second!.teaTurn);
        expect(second.visible).not.toContain(facts.second!.catTurn);
      }
      service.mutate('owner', { memoryId: facts.owner!.tea, action: 'restore' });
      service.mutate('owner', { memoryId: facts.owner!.cat, action: 'forget' });
      service.mutate('second', { memoryId: facts.second!.cat, action: 'restore' });
      service.mutate('second', { memoryId: facts.second!.tea, action: 'forget' });
      [facts.owner, facts.second] = [{ ...facts.owner!, teaTurn: facts.owner!.catTurn, catTurn: facts.owner!.teaTurn },
        { ...facts.second!, teaTurn: facts.second!.catTurn, catTurn: facts.second!.teaTurn }];
    }
  }, 120_000);
});

describe('the cost of the visibility check on a later turn', () => {
  it('compares nothing again while the withheld items are unchanged, and only what is new after a new turn', () => {
    const { world, say, facts, service } = build();
    for (let index = 0; index < 150; index += 1) say('owner', `散歩の記録${index}を残したい`, `散歩${index}の記録ですね。`);
    service.mutate('owner', { memoryId: facts.owner!.tea, action: 'forget' });
    const turn = () => prepareTurnCognitiveContext(world.store.snapshot('owner'), world.store, { scopeKey: 'owner', message: '散歩の話',
      occurredAt: world.now(), channel: 'voice', present: OWNER_AUDIENCE });
    turn();
    const first = { ...memoryEvidenceCounters };
    // Each turn reads the state again (her feeling moved: a new object and version, the same memory).
    world.store.apply('owner', { type: 'emotion-adjusted', delta: { valence: 0.05 } });
    turn();
    expect(memoryEvidenceCounters.compared - first.compared).toBe(0);
    // Each state object the turn reads gathers its withheld evidence once (a few small passes over the items, no turn compared).
    expect(memoryEvidenceCounters.indexed - first.indexed).toBeLessThanOrEqual(4);

    const before = memoryEvidenceCounters.compared;
    say('owner', '新しい散歩道を見つけた', '新しい道ですね。');
    turn();
    expect(memoryEvidenceCounters.compared - before).toBeGreaterThan(0);
    expect(memoryEvidenceCounters.compared - before).toBeLessThanOrEqual(6);

    // A forget changes what is withheld: the turns are compared afresh, not served from before.
    const beforeForget = memoryEvidenceCounters.compared;
    service.mutate('owner', { memoryId: facts.owner!.cat, action: 'forget' });
    turn();
    expect(memoryEvidenceCounters.compared - beforeForget).toBeGreaterThan(150);
  }, 120_000);
});
