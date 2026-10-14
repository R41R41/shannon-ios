import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_WHEN_NATURAL, CHARACTER_CORE, CHARACTER_CORE_SPEECH, INNER_NOTE_ADDRESS_LINE, buildExpressiveEmotionPrompt, createInitialCompanionState,
  innerNoteExpressiveEmotionPrompt, innerNoteReflectionInput, innerNoteReflectionInstructions, innerNoteTouchBlock, touchConsentIn,
  type CompanionStateSnapshot, type InnerNote, type InnerNoteDraft, type InnerNoteEvent, type InnerNoteReflectionFacts, type ShannonExpressiveEmotion,
} from '@shannon/cognition';
import { BODY_REACTION_LIMITS } from '../src/contracts/bodyReactionContract.js';
import { BODY_REACTION_HONNE_LINE, BODY_REACTION_INNER_RULES, BODY_REACTION_OTHERS_RULE } from '../src/surfaces/body/bodyReactionPrompt.js';
import { VOICE_HONNE_LINE } from '../src/surfaces/body/bodyReaction.js';
import type { InnerNoteBodyReader, InnerNotePort, InnerNoteTouch, InnerNoteTurn } from '../src/mind/emotion/innerNotePorts.js';
import { InnerNoteService } from '../src/mind/emotion/innerNoteService.js';
import type { InnerNoteReflector } from '../src/mind/emotion/innerNoteReflection.js';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import { MINUTE, SECOND, reactionHarness } from './bodyReactionHarness.js';

/**
 * Human-likeness fixes of 2026-10-14 (the owner's Windows call, 11:01–11:08 JST: 「まだ全然人間っぽくない」). Nine of ten touch lines said
 * 「びっくり」, 「えっ、また！？」 came twelve seconds after 「もちろんいいですよ」, the voice apologized for 「急に大きな声を出して」 because it
 * never knew its preceding line was a touch line, and every voice reply opened with 「ライ氏、」. Owner decisions of the same day: no
 * scripted lines anywhere; her note reflects at once only on a big change (another part, touching allowed or refused in conversation).
 */

/** A port of her inner note that records what it is told and has no note (the switch on, nothing written yet). */
class RecordingPort implements InnerNotePort {
  readonly timeZone = 'Asia/Tokyo';
  readonly touches: InnerNoteTouch[] = [];
  readonly turns: InnerNoteTurn[] = [];
  current(): InnerNote | null { return null; }
  pending(): readonly InnerNoteEvent[] { return []; }
  turnEnded(turn: InnerNoteTurn): void { this.turns.push(turn); }
  touched(touch: InnerNoteTouch): void { this.touches.push(touch); }
  bind(): void {}
  body: InnerNoteBodyReader | null = null;
  useBody(reader: InnerNoteBodyReader): void { this.body = reader; }
}

const chest = { type: 'poke', durationMs: 200, ongoing: false, region: 'body', part: 'chest', gesture: 'poke' };
const head = { type: 'pet', durationMs: 1_500, ongoing: true, region: 'head', part: 'head', gesture: 'stroke' };

describe('the touch prompt with her note on (A)', () => {
  it('puts the scene first, shows no example line and no 「N回目」, and carries her core\'s speech lines', async () => {
    const port = new RecordingPort();
    const { said, speaker, chat } = await reactionHarness({ innerNote: port });
    for (const words of ['今日はいい天気だね', '原稿どう？', '少し休憩しよう', '触ってもいい？']) await chat(words);
    await said(chest);
    const prompt = speaker.prompts[0]!;
    // The scene is the first block after who she is: a permission just given is what the touch happens in.
    const blocks = prompt.split('\n\n');
    expect(blocks[0]).toContain(CHARACTER_CORE.summary);
    expect(blocks[0]).toContain(CHARACTER_CORE_SPEECH);
    for (const cue of ['ひゃっ', 'ふふん', 'じゃん', '同じ言い回しが続くと、自分でも飽きる']) expect(blocks[0]).toContain(cue);
    expect(blocks[1]!.startsWith('[いまの場面]')).toBe(true);
    expect(prompt.indexOf('[いまの場面]')).toBeLessThan(prompt.indexOf('[体に触れられた]'));
    const scene = blocks[1]!.split('\n').slice(1);
    expect(scene).toHaveLength(BODY_REACTION_LIMITS.sceneMessages);
    expect(scene.at(-2)).toBe('ライ氏: 触ってもいい？');
    // No example line, no count framed as repetition, silence worded as a way to answer.
    for (const scripted of ['また？', '回目', '黙ることも多い', '[いまの会話]']) expect(prompt).not.toContain(scripted);
    for (const rule of BODY_REACTION_INNER_RULES) expect(prompt).toContain(rule);
    expect(prompt).toContain('言葉にせず顔や体で返すのも、ちゃんとした返し方のひとつ');
    expect(prompt).toMatch(/- 体をつつかれた: いまのだけ\n/u);
    // Her reception is her own, and her words may hide it: a choice she makes knowing it (5).
    expect(prompt).toContain(BODY_REACTION_HONNE_LINE);
    expect(prompt).toContain('[触れられてボクがさっき言ったこと] なし');
  });

  it('shows her own last five touch lines, one a line, oldest first, so that she can say something else', async () => {
    const { said, speaker, advance } = await reactionHarness({ innerNote: new RecordingPort() });
    const lines = ['いちばん最初のひとこと', 'もう、なんですか', '慣れてきました', 'ちょっと、くすぐったいです', 'まだやるんですか', 'はいはい'];
    speaker.script = call => ({ say: true, text: lines[call - 1] ?? 'えっと', feeling: 'bashful' as const, stance: 'fine' as const });
    for (let index = 0; index < 7; index += 1) {
      await said(head);
      advance(40 * SECOND);
    }
    const last = speaker.prompts[6]!;
    expect(last).toContain(`[触れられてボクがさっき言ったこと]（古い順）\n${lines.slice(1).map(line => `- 「${line}」`).join('\n')}\n`);
    expect(last).not.toContain('いちばん最初のひとこと');
    // Nor 「（続けて7回目）」 in the cause of her feeling: the count is told once.
    expect(last).not.toContain('続けて');
    // The count of this run of touches is a plain fact, not 「この数分で7回目」.
    expect(last).toMatch(/- 頭をなでられた: \d+分前から7回（いまのをふくむ）/u);
  });

  it('with other people present: no scene, only lines said in front of them, and the rule for the room', async () => {
    const { said, speaker, chat, advance } = await reactionHarness({ innerNote: new RecordingPort() });
    speaker.script = call => ({ say: true, text: ['二人だけの時のひとこと', 'みんなの前でのひとこと', 'もうひとこと'][call - 1]!, feeling: 'happy' as const });
    await chat('内緒だけど、来週の診察がこわい');
    await said(head);
    advance(30 * SECOND);
    await said(head, { audience: 'others' });
    advance(30 * SECOND);
    await said(head, { audience: 'others' });
    const prompt = speaker.prompts[2]!;
    for (const secret of ['[いまの場面]', '診察', '内緒', '二人だけの時のひとこと']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('- 「みんなの前でのひとこと」');
    expect(prompt).toContain(BODY_REACTION_OTHERS_RULE);
  });

  it('tells her note the part and her recent lines, and hands it the counts by part (owner alone only)', async () => {
    const port = new RecordingPort();
    const { said, speaker, advance, now } = await reactionHarness({ innerNote: port });
    speaker.script = call => ({ say: true, text: `ひとこと${call}`, feeling: 'surprised' as const, stance: 'unsure' as const });
    await said(chest);
    advance(40 * SECOND);
    await said(chest);
    advance(40 * SECOND);
    await said(head);
    advance(40 * SECOND);
    await said(chest, { audience: 'others' });
    expect(port.touches.map(touch => touch.part)).toEqual(['胸', '胸', '頭', '胸']);
    expect(port.touches[2]).toMatchObject({ lines: ['ひとこと1', 'ひとこと2', 'ひとこと3'] });
    // With others present nothing of her day is handed on (the note takes no touch anyone else may have made).
    expect(port.touches[3]).not.toHaveProperty('lines');
    // The counts are read when she reflects, of the owner's touches alone.
    expect(port.body!.partCounts('owner', '2026-10-01T00:00:00.000Z', now())).toEqual([{ part: '胸', count: 2 }, { part: '頭', count: 1 }]);
  });
});

describe('the voice knows its preceding line was a touch line (B)', () => {
  const answering = async (innerNote?: RecordingPort) => {
    const harness = await reactionHarness(innerNote ? { innerNote } : {});
    harness.speaker.decision = { say: true, text: 'ひゃっ、いきなり？', feeling: 'surprised', stance: 'dislike' };
    await harness.said(chest);
    harness.advance(3 * SECOND);
    return harness;
  };

  it('annotates the line it answers with the part and her reception, and keeps the fact for a few minutes whatever its salience', async () => {
    const { delegate, chatModel, advance } = await answering(new RecordingPort());
    expect((await delegate('そんなにびっくりする？', { reactionId: 'touch-1' })).status).toBe(200);
    const first = chatModel.voiceRequests[0]!;
    expect(first.precedingReply).toBe('ひゃっ、いきなり？');
    expect(first.turnContext).toContain('[さっきの体のこと]');
    expect(first.turnContext).toContain('- さっき: ライ氏に胸をつつかれた。ボクの受け取り（本音）: いや。ボクの一言「ひゃっ、いきなり？」（ライ氏がいま答えている、直前のボクの言葉）');
    expect(first.turnContext).toContain(VOICE_HONNE_LINE);
    // Three minutes later, another turn that answers no line: the touch is still there as a fact.
    advance(3 * MINUTE);
    await delegate('さっきのこと怒ってる？');
    expect(chatModel.voiceRequests[1]!.turnContext).toContain('- 3分前: ライ氏に胸をつつかれた。ボクの受け取り（本音）: いや。ボクの一言「ひゃっ、いきなり？」');
    expect(chatModel.voiceRequests[1]!.turnContext).not.toContain('いま答えている');
    // After the window it is gone.
    advance(BODY_REACTION_LIMITS.voiceFactMilliseconds);
    await delegate('ところで');
    expect(chatModel.voiceRequests[2]!.turnContext ?? '').not.toContain('[さっきの体のこと]');
  });

  it('without her note (SHANNON_INNER_NOTE off): nothing of it, the voice turn as before', async () => {
    const { delegate, chatModel } = await answering();
    await delegate('そんなにびっくりする？', { reactionId: 'touch-1' });
    expect(chatModel.voiceRequests[0]!.precedingReply).toBe('ひゃっ、いきなり？');
    for (const absent of ['[さっきの体のこと]', '受け取り', '体に触れられて言ったひとこと', VOICE_HONNE_LINE]) {
      expect(chatModel.voiceRequests[0]!.turnContext ?? '').not.toContain(absent);
    }
  });

  it('never names the part or her reception while anyone else may hear, and a friend\'s own call gets nothing of it', async () => {
    const { delegate, chatModel } = await answering(new RecordingPort());
    const others = { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, companionPresent: true };
    expect((await delegate('シャノン、そんなにびっくりする？', { reactionId: 'touch-1', deviceContext: others })).status).toBe(200);
    const context = chatModel.voiceRequests[0]!.turnContext ?? '';
    expect(context).toContain('直前の「ひゃっ、いきなり？」は、体に触れられて言ったひとこと。');
    for (const secret of ['胸', '受け取り', 'いや', '[さっきの体のこと]']) expect(context).not.toContain(secret);
    await delegate('シャノン、ねえ', { deviceContext: others });
    expect(chatModel.voiceRequests[1]!.turnContext ?? '').not.toMatch(/胸|受け取り|さっきの体のこと/u);
    const before = chatModel.voiceRequests.length;
    await delegate('シャノン、こんにちは', { participantMode: 'guest' });
    expect(chatModel.voiceRequests).toHaveLength(before + 1);
    expect(chatModel.voiceRequests.at(-1)!.turnContext ?? '').not.toMatch(/胸|受け取り|さっきの体のこと/u);
  });
});

const T0 = '2026-10-14T02:01:00.000Z'; // 11:01 in Tokyo
const draft = (): InnerNoteDraft => ({
  text: { honne: 'びっくりした。', tatemae: '平気なふり。', reason: '安く見られたくない。', plan: 'しばらくこのまま。', bottom: '好きなまま。' },
  shown: 'flustered', tell: 'none', intent: 'none', scale: 'ordinary', dayReason: null, untilMinutes: null, changeReason: null,
  routeSummary: 'Shannon is a little flustered.', summary: null,
});

function service(limits: Record<string, number> = {}, counts: { part: string; count: number }[] = []) {
  let now = T0;
  const facts: InnerNoteReflectionFacts[] = [];
  const logs: string[] = [];
  const reflector: InnerNoteReflector = { model: 'test', async reflect(request) { facts.push(request.facts); return { draft: draft(), usage: null }; } };
  const store = new SQLiteInnerNoteStore(new DatabaseSync(':memory:'));
  const snapshot: CompanionStateSnapshot = createInitialCompanionState('owner', T0);
  const notes = new InnerNoteService({ store, reflector, state: { snapshot: () => snapshot }, ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => now,
    manual: true, limits, log: line => logs.push(line) });
  notes.useBody({ partCounts: () => counts });
  const at = (seconds: number) => { now = new Date(Date.parse(T0) + seconds * 1_000).toISOString(); return now; };
  const touch = (seconds: number, part: string, extra: Partial<InnerNoteTouch> = {}): InnerNoteTouch => ({ scopeKey: 'owner', audience: 'owner',
    at: at(seconds), touchId: `t-${seconds}`, phrase: `ライ氏に${part}をつつかれた`, kind: 'poke', part, stance: 'unsure', ...extra });
  const turn = (seconds: number, userMessage: string, reply: string): InnerNoteTurn => ({ scopeKey: 'owner', surface: 'voice', alone: true,
    at: at(seconds), userMessage, reply, feeling: null });
  return { notes, store, facts, logs, touch, turn };
}

describe('her note reflects at once on a big change only (C, owner decision 2026-10-14)', () => {
  it('reflects when the touched part changes, and keeps coalescing touches on the same part', async () => {
    const { notes, facts, touch } = service();
    notes.touched(touch(0, '胸'));
    await notes.flush('owner');
    notes.touched(touch(45, '胸'));
    await notes.flush('owner');
    expect(facts).toHaveLength(1);
    notes.touched(touch(90, '頭'));
    await notes.flush('owner');
    // The touch on another part, with the one the session held before it.
    expect(facts).toHaveLength(2);
    expect(facts[1]!.events.map(event => event.touch?.phrase)).toEqual(['ライ氏に胸をつつかれた', 'ライ氏に頭をつつかれた']);
  });

  it('reflects when touching is allowed or refused in conversation, her own yes or no included', async () => {
    const { notes, facts, store, turn } = service();
    notes.turnEnded(turn(0, 'シャノン、触ってもいい？', 'もちろんいいですよ'));
    await notes.flush('owner');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.events).toMatchObject([{ kind: 'consent', consent: 'permitted', words: 'シャノン、触ってもいい？', reply: 'もちろんいいですよ' }]);
    expect(store.latest('owner')!.triggers).toEqual(['consent']);
    notes.turnEnded(turn(60, 'もう一回頭なでていい？', 'だめです'));
    await notes.flush('owner');
    expect(facts[1]!.events.at(-1)).toMatchObject({ kind: 'consent', consent: 'refused' });
    // An ordinary turn is not one.
    notes.turnEnded(turn(120, '今日の天気は？', '晴れです'));
    await notes.flush('owner');
    expect(facts).toHaveLength(2);
  });

  it('counts 「触ってもいい？」 without her name or a part only within minutes of a touch of his', async () => {
    const { notes, facts, touch, turn } = service();
    notes.turnEnded(turn(0, '触ってもいい？', 'もちろんいいですよ'));
    await notes.flush('owner');
    expect(facts).toHaveLength(0);
    notes.touched(touch(10, '頭'));
    await notes.flush('owner');
    notes.turnEnded(turn(70, '触ってもいい？', 'もちろんいいですよ'));
    await notes.flush('owner');
    expect(facts.at(-1)!.events.at(-1)).toMatchObject({ kind: 'consent', consent: 'permitted' });
    const before = facts.length;
    notes.turnEnded(turn(10 + 6 * 60, '触ってもいい？', 'もちろんいいですよ'));
    await notes.flush('owner');
    expect(facts).toHaveLength(before);
  });

  it('gives the reflection today\'s counts by part, her recent touch lines and the turns about touching, and asks her whether it was on purpose', async () => {
    const { notes, facts, touch, turn } = service({}, [{ part: '胸', count: 2 }, { part: '頭', count: 1 }]);
    notes.turnEnded(turn(0, 'シャノン、触ってもいい？', 'もちろんいいですよ'));
    await notes.flush('owner');
    notes.touched(touch(12, '胸', { said: 'えっ、また！？', lines: ['ひゃっ', 'えっ、また！？'] }));
    await notes.flush('owner');
    const last = facts.at(-1)!;
    expect(last.touches).toEqual({ today: [{ part: '胸', count: 2 }, { part: '頭', count: 1 }], lines: ['ひゃっ', 'えっ、また！？'] });
    expect(last.consents).toMatchObject([{ kind: 'consent', consent: 'permitted' }]);
    const input = innerNoteReflectionInput(last);
    expect(input).toContain('[今日、体に触れられた回数]（場所ごと。事実として）胸 2回、頭 1回');
    expect(input).toContain('[触れられてボクが言ったこと]（古い順）「ひゃっ」「えっ、また！？」');
    expect(input).toContain('[触れることについての会話]（今日。事実として）');
    expect(input).toContain('ボクが触れるのを許した');
    const instructions = innerNoteReflectionInstructions();
    expect(instructions).toContain('それはわざと？');
    expect(instructions).toContain('構えとして書く（次に言うせりふは書かない');
  });

  it('keeps the touches\' own cap of 24 a day when every touch is on another part, and the day\'s cap over everything', async () => {
    const { notes, facts, touch, logs } = service({ reflectionsPerDay: 96 });
    for (let index = 0; index < 40; index += 1) {
      notes.touched(touch(index * 45, index % 2 ? '胸' : '頭'));
      await notes.flush('owner');
    }
    expect(facts.filter(fact => fact.events.every(event => event.kind === 'touch'))).toHaveLength(24);
    expect(logs).toContain('inner_note_touch_cap');
    const capped = service({ reflectionsPerDay: 2 });
    for (const [index, words] of ['シャノン、触ってもいい？', '頭なでていい？', 'ほっぺつついていい？'].entries()) {
      capped.notes.turnEnded(capped.turn(index * 60, words, 'いいですよ'));
      await capped.notes.flush('owner');
    }
    expect(capped.facts).toHaveLength(2);
    expect(capped.logs).toContain('inner_note_daily_cap');
  });

  it('reads a turn about touching narrowly: no false trigger on the corpus, and the misses counted', () => {
    const fp: string[] = [];
    const fn: string[] = [];
    for (const [words, reply, recentTouch, expected] of CONSENT_CORPUS) {
      const got = touchConsentIn(words, reply, recentTouch ? { recentTouch: true } : {});
      if (expected === null && got !== null) fp.push(`${words} → ${got}`);
      else if (expected !== null && got !== expected) fn.push(`${words} → ${got} (want ${expected})`);
    }
    // When in doubt, nothing: a false one writes 「ボクが触れるのを許した」 as a fact. The misses are pinned so a change shows.
    expect(fp).toEqual([]);
    expect(fn).toEqual(CONSENT_KNOWN_MISSES);
    expect(CONSENT_CORPUS.length).toBeGreaterThanOrEqual(100);
  });
});

describe('her note counts her body when it reflects, after any forgetting (C, review of e47da81c)', () => {
  it('leaves a burst he had her forget out of the counts of a later reflection', async () => {
    const facts: InnerNoteReflectionFacts[] = [];
    const reflector: InnerNoteReflector = { model: 'test', async reflect(request) { facts.push(request.facts); return { draft: draft(), usage: null }; } };
    let clock = () => '';
    const notes = new InnerNoteService({ store: new SQLiteInnerNoteStore(new DatabaseSync(':memory:')), reflector, ownerScope: 'owner', timeZone: 'Asia/Tokyo',
      state: { snapshot: scope => harness.stateStore.snapshot(scope) }, now: () => clock(), manual: true });
    const harness = await reactionHarness({ innerNote: notes });
    clock = harness.now;
    await harness.said(chest);
    harness.advance(40 * SECOND);
    await harness.said(head);
    const chestBurst = harness.reactionStore.burstOfTouch('owner', 'touch-1')!.id;
    harness.advance(40 * SECOND);
    harness.stateStore.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: chestBurst, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: harness.now(), changeReason: 'ライ氏が忘れてと言った',
    } });
    const before = facts.length;
    notes.turnEnded({ scopeKey: 'owner', surface: 'voice', alone: true, at: harness.now(), userMessage: 'シャノン、頭なでてもいい？', reply: 'いいですよ', feeling: null });
    await notes.flush('owner');
    expect(facts.length).toBeGreaterThan(before);
    const last = facts.at(-1)!;
    expect(last.events.at(-1)).toMatchObject({ kind: 'consent', consent: 'permitted' });
    expect(last.touches?.today).toEqual([{ part: '頭', count: 1 }]);
  });
});

describe('her note\'s つもり is a stance, never a line to say (C)', () => {
  it('is labelled so in the touch prompt\'s block', () => {
    const note = { text: { honne: 'びっくりした', tatemae: '平気なふり', reason: '', plan: '次も素直にびっくりと言う', bottom: '好き' },
      hooks: { shown: 'flustered', tell: 'none', until: null, scale: 'ordinary', dayReason: null, intent: 'none', routeSummary: '' }, closedAt: null,
      flags: {}, dayEndsAt: '2026-10-14T18:00:00.000Z', createdAt: T0 } as unknown as InnerNote;
    expect(innerNoteTouchBlock(note, 'owner', T0)).toContain('- つもり（構え。言うせりふではない）: 次も素直にびっくりと言う');
  });
});

describe('ライ氏 only when it means something (4)', () => {
  const emotion = { primary: 'happy', secondary: [], intensity: 0.5, visibility: 'subtle', target: 'ライ氏', cause: 'test', carryover: 0, decay: 0.1 } as unknown as ShannonExpressiveEmotion;

  it('replaces 「address the owner as ライ氏 when natural」 with her note on, and leaves the switched-off block as it was', () => {
    expect(buildExpressiveEmotionPrompt(emotion, 'owner')).toContain(ADDRESS_WHEN_NATURAL);
    for (const audience of ['owner', 'others'] as const) {
      const prompt = innerNoteExpressiveEmotionPrompt(emotion, audience);
      expect(prompt).toContain(INNER_NOTE_ADDRESS_LINE);
      expect(prompt).not.toContain('when natural');
      expect(prompt).toContain('never as the opening of a reply');
    }
    // A guest's line never named him: it keeps its own wording.
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'guest')).toContain('do not address them as ライ氏');
    expect(innerNoteExpressiveEmotionPrompt(emotion, 'guest')).not.toContain(INNER_NOTE_ADDRESS_LINE);
  });
});

type ConsentCase = readonly [words: string, reply: string, recentTouch: boolean, expected: 'asked' | 'permitted' | 'refused' | null];
/**
 * About a hundred turns, measured (reviews of e47da81c and 077abda7). The owner is a developer: most turns with 触る are about work.
 * `recentTouch` is a touch of his within five minutes. Expected null means: must never be read as about her body.
 */
const CONSENT_CORPUS: readonly ConsentCase[] = [
  // Her body, named (a word of its own right before the verb).
  ['シャノン、触ってもいい？', 'もちろんいいですよ', false, 'permitted'],
  ['シャノンに触っていい？', 'どうぞ', false, 'permitted'],
  ['頭なでていい？', 'いいですよ', false, 'permitted'],
  ['頭なでていい？', 'だめです', false, 'refused'],
  ['もう一回頭なでていい？', 'しょうがないですね', false, 'permitted'],
  ['ほっぺつついてもいい？', 'やだ', false, 'refused'],
  ['ほっぺつついてもいい？', 'えー、いいけど', false, 'permitted'],
  ['君の髪なでてもいい？', 'えっと……', false, 'asked'],
  ['手をつないでいい？', 'しょうがないですね', false, 'permitted'],
  ['手を握っていい？', 'いいですよ', false, 'permitted'],
  ['手を握ってもいい？', 'やめて', false, 'refused'],
  ['頭ぽんぽんしていい？', 'ふふん、どうぞ', false, 'permitted'],
  ['頭なでなでしていい？', '特別ですよ', false, 'permitted'],
  ['肩もんでいい？', 'いいですよ', false, 'permitted'],
  ['ねえきみ、触っていい？', 'いいですよ', false, 'permitted'],
  ['髪さわっていい？', 'いいですよ', false, 'permitted'],
  ['シャノン、ぎゅってしていい？', 'えっ……いいですよ', false, 'permitted'],
  ['シャノン、ハグしていい？', 'だめです', false, 'refused'],
  ['シャノン、抱っこしていい？', 'やだ', false, 'refused'],
  ['シャノン、抱きしめていい？', 'しょうがないですね', false, 'permitted'],
  ['もう頭なでないよ', 'そうですか', false, 'refused'],
  ['もう君の頭は触らないよ', 'ふーん', false, 'refused'],
  ['お腹つついていい？', 'お断りです', false, 'refused'],
  ['顔さわっていい？', 'いやです', false, 'refused'],
  ['頬つついてもいい？', 'どうぞ', false, 'permitted'],
  ['首さわっていい？', 'だめ', false, 'refused'],
  // Within minutes of a touch of his, the bare verb.
  ['触ってもいい？', 'もちろんいいですよ', true, 'permitted'],
  ['触っていい？', 'だめです', true, 'refused'],
  ['もう一回触っていい？', 'いいですよ', true, 'permitted'],
  ['ちょっと触らせて', 'えっと……', true, 'asked'],
  ['もう触らないよ', 'そうしてください', true, 'refused'],
  ['もう抱きしめないよ', 'べつにいいですけど', true, 'refused'],
  ['もうなでないよ', 'そうですか', true, 'refused'],
  ['ぎゅってしていい？', 'いいですよ', true, 'permitted'],
  ['ハグしていい？', 'やだ', true, 'refused'],
  ['抱っこしていい？', 'しょうがないですね', true, 'permitted'],
  ['なでなでしていい？', 'しょうがないですね', true, 'permitted'],
  ['ねえ、触っていい？', 'どうぞ', true, 'permitted'],
  ['またつついていい？', 'だめです', true, 'refused'],
  ['触らないで、って言った？', 'はい', true, null],
  // The bare verb without a touch of his: not known to be about her.
  ['触ってもいい？', 'もちろんいいですよ', false, null],
  ['なでなでしていい？', 'しょうがないですね', false, null],
  ['もう触らないよ', 'そうしてください', false, null],
  ['ぎゅってしていい？', 'いいですよ', false, null],
  // Compounds that only contain a body word (review of 077abda7).
  ['全体触っていい？', 'いいですよ', false, null],
  ['本体触っていい？', 'いいですよ', false, null],
  ['補足に触れてもいい？', 'いいですよ', false, null],
  ['冒頭に少し触れてもいい？', 'いいですよ', false, null],
  ['先頭触っていい？', 'どうぞ', false, null],
  ['笑顔に触れていい？', 'いいですよ', false, null],
  ['相手を触っていい？', 'いいですよ', false, null],
  ['右手で触っていい？', 'いいですよ', false, null],
  ['手首さわっていい？', 'いいですよ', false, null],
  ['身体性の議論に触れてもいい？', 'どうぞ', false, null],
  ['具体例に触れていい？', 'いいですよ', false, null],
  ['主体を触っていい？', 'いいですよ', false, null],
  ['人体模型触っていい？', 'どうぞ', false, null],
  ['ぶきみな所触っていい？', 'いいですよ', false, null],
  // Work, also right after a touch (reviews of e47da81c and 077abda7).
  ['このファイル触っていい？', 'いいですよ', true, null],
  ['Notionのページ触っていい？', 'どうぞ', true, null],
  ['その話に触れてもいい？', 'いいですよ', true, null],
  ['さわりだけ話していい？', 'いいよ', true, null],
  ['接触しませんでした', 'だめですよ', true, null],
  ['触ってないよ', 'いいですよ', true, null],
  ['触ってないよ', 'ほんとですか？', true, null],
  ['DBに触っても大丈夫？', '大丈夫です', true, null],
  ['この手順触っていい？', 'どうぞ', true, null],
  ['実装触っていい？', 'いいですよ', true, null],
  ['config触っていい？', 'いいですよ', true, null],
  ['API触っていい？', 'どうぞ', true, null],
  ['UI触っていい？', 'いいですよ', true, null],
  ['iPhone触っていい？', 'いいですよ', true, null],
  ['この関数触っていい？', 'いいですよ', true, null],
  ['ヘッダ触っていい？', 'どうぞ', true, null],
  ['Mac触っていい？', 'いいですよ', true, null],
  ['ワークフロー触っていい？', 'いいですよ', true, null],
  ['もう本番は触らないよ', 'そうしてください', true, null],
  ['リポジトリ触っていい？', 'いいですよ', true, null],
  ['ブランチ触ってもいい？', 'どうぞ', true, null],
  ['設定をちょっと触ってもいい？', 'いいですよ', true, null],
  ['シャノンのコード触っていい？', 'いいですよ', true, null],
  ['シャノンの設定触っていい？', 'だめです', true, null],
  ['シャノン、この実装触っていい？', 'どうぞ', true, null],
  ['ログ触らないでね', 'はい', true, null],
  ['デプロイ環境には触らないよ', 'お願いします', true, null],
  ['仕様に触れておくね', 'どうぞ', true, null],
  ['原稿触っていい？', 'いいですよ', true, null],
  ['感触はどう？', 'いいですよ', true, null],
  ['触媒の話をしよう', 'いいですよ', true, null],
  ['新しいモデル触った？', 'まだです', true, null],
  ['猫なでていい？', 'いいですよ', true, null],
  ['犬なでてきた', 'いいなあ', true, null],
  ['みんなで行っていい？', 'いいですよ', true, null],
  ['原稿は進みつつありません', 'そうですか', true, null],
  ['Wi-Fiつないでいい？', 'いいですよ', true, null],
  ['サーバにつないでいい？', 'どうぞ', true, null],
  ['今日の天気は？', 'いいですよ、晴れです', true, null],
  ['この資料を触っておいて', '了解です', true, null],
  ['握手しよう', 'いいですよ', true, null],
  ['ハンドル握っていい？', 'どうぞ', true, null],
  ['触りませんでした', 'そうですか', true, null],
  ['昨日は触ってない', 'そうですね', true, null],
  ['手伝っていい？', 'いいですよ', true, null],
  ['体調どう？', 'いいですよ', true, null],
];
/** Turns about her the reading still misses (measured; the safe side). */
const CONSENT_KNOWN_MISSES: readonly string[] = [
  // もむ is not one of the gestures; きみ right after ねえ is not a word's start. Missed rather than risk a false trigger.
  '肩もんでいい？ → null (want permitted)',
  'ねえきみ、触っていい？ → null (want permitted)',
];
