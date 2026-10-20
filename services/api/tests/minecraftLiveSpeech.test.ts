import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import type { MinecraftControlPoll, MinecraftLiveSpeechReceipt } from '../src/contracts/minecraftControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { LIVE_COMMENTARY_ENGINE, LiveCommentary, type LiveWriteRequest } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LIVE_SPEECH_LIMITS, LiveSpeechOutbox, type LiveSpeechDraft } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';
import { cleanLiveLine, liveWriterPrompt, LIVE_LINE_LIMITS } from '../src/surfaces/minecraft/minecraftLiveWriter.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { validControlPoll } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';

const draft = (id: string, patch: Partial<LiveSpeechDraft> = {}): LiveSpeechDraft => ({ id, text: `言葉${id}`, urgency: 'ordinary', kind: 'diamond_found', ttlMilliseconds: 20_000, ...patch });

describe('LiveSpeechOutbox', () => {
  let clock = 1_000_000;
  const outbox = () => new LiveSpeechOutbox(() => clock);
  beforeEach(() => { clock = 1_000_000; });

  it('hands the line due, one at a time, and offers it again only after a few seconds without an answer', () => {
    const box = outbox();
    box.enqueue(draft('a'));
    box.enqueue(draft('b'));
    expect(box.take().map(item => item.id)).toEqual(['a']);
    expect(box.take()).toEqual([{ id: 'b', text: '言葉b', urgency: 'ordinary', kind: 'diamond_found', expiresAt: new Date(clock + 20_000).toISOString() }]);
    expect(box.take()).toEqual([]);
    clock += LIVE_SPEECH_LIMITS.reofferMilliseconds;
    expect(box.take().map(item => item.id)).toEqual(['a']);
  });

  it('ends a line with the body\'s receipt, or with its own when the body never answers', () => {
    const box = outbox(), ended: Array<[string, string, string | undefined]> = [];
    box.onEnd((receipt, item) => ended.push([item.id, receipt.outcome, receipt.reason]));
    box.enqueue(draft('a'));
    box.enqueue(draft('b'));
    box.take();
    box.receive([{ id: 'a', outcome: 'spoken' }, { id: 'unknown', outcome: 'posted' }], null);
    expect(ended).toEqual([['a', 'spoken', undefined]]);
    for (let offer = 0; offer < LIVE_SPEECH_LIMITS.offers + 1; offer++) {
      box.take();
      clock += LIVE_SPEECH_LIMITS.reofferMilliseconds;
    }
    box.take();
    expect(ended.at(-1)).toEqual(['b', 'failed', 'lost']);
    expect(box.pending()).toBe(0);
  });

  it('drops a line whose time is up, and pushes out the oldest ordinary one when too many wait', () => {
    const box = outbox(), ended: string[] = [];
    box.onEnd((receipt, item) => ended.push(`${item.id}:${receipt.reason}`));
    box.enqueue(draft('a', { ttlMilliseconds: 1_000 }));
    clock += 2_000;
    expect(box.take()).toEqual([]);
    expect(ended).toEqual(['a:expired']);
    for (const id of ['b', 'c', 'd']) box.enqueue(draft(id, id === 'b' ? { urgency: 'urgent' } : {}));
    box.enqueue(draft('e'));
    expect(ended.at(-1)).toBe('c:pushed_out');
    expect(box.pending()).toBe(3);
  });

  it('keeps the room the body told while its reading is current', () => {
    const box = outbox();
    expect(box.room()).toBeNull();
    box.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: 4000 });
    expect(box.room()).toEqual({ voice: true, humanSpeaking: false, sinceHumanMs: 4000 });
    clock += LIVE_SPEECH_LIMITS.roomMilliseconds + 1;
    expect(box.room()).toBeNull();
  });

  it('survives a listener that throws', () => {
    const box = outbox();
    box.onEnd(() => { throw new Error('no'); });
    box.enqueue(draft('a'));
    box.take();
    expect(() => box.receive([{ id: 'a', outcome: 'declined', reason: 'busy' }], null)).not.toThrow();
  });
});

describe('the writer', () => {
  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}): LiveMoment => ({ kind, key: kind, at: 0, facts });

  it('asks for one short line from the facts, for a shared room, with her persona and her last words', () => {
    const { system, message } = liveWriterPrompt({ identity: '【ボクの人物】', persona: '[いまのボク]\nいまのボク: いつもの', body: '[マイクラの体の今]\n- 体力 20/20',
      main: moment('diamond_found', { count: 2 }), also: [moment('armor_complete')], recent: ['夜だね'], voice: true });
    expect(system.startsWith('【ボクの人物】')).toBe(true);
    for (const part of ['[いまのボク]', '[実況の一言]', '声に出す一言。1文、54字以内', '[マイクラの体の今]', '[さっき言ったこと]\n- 夜だね', '[いま起きたこと]\n- ダイヤモンドの鉱石を見つけた（2か所）。',
      '[ほかにあったこと（ついでに触れてもよい）]\n- 鉄以上の防具が頭から足までそろい、着ている。', 'ライ氏に頼まれた作業の中身は、この場では言わない']) {
      expect(system).toContain(part);
    }
    expect(message).toContain('実況の一言');
    const text = liveWriterPrompt({ identity: 'I', persona: '', body: '', main: moment('night_fell'), also: [], recent: [], voice: false });
    expect(text.system).toContain('文字で書く一言。1文、100字以内');
    expect(text.system).not.toContain('[さっき言ったこと]');
  });

  it('takes the first line of the answer as the one to say and refuses what is not a line', () => {
    expect(cleanLiveLine('「ダイヤ見つけた！」', { voice: true })).toBe('ダイヤ見つけた！');
    expect(cleanLiveLine('ボク：おっ、夜になってきた\nもう一行', { voice: false })).toBe('おっ、夜になってきた');
    expect(cleanLiveLine('', { voice: true })).toBeNull();
    expect(cleanLiveLine('- 見つけた', { voice: true })).toBeNull();
    expect(cleanLiveLine('詳しくは https://example.com で', { voice: false })).toBeNull();
    expect(cleanLiveLine('@everyone 見て', { voice: false })).toBeNull();
    expect(cleanLiveLine('場所は 120, 64, -30 のあたり', { voice: false })).toBeNull();
    expect(cleanLiveLine('mc.mine-block を呼んだ', { voice: false })).toBeNull();
    const long = `${'あ'.repeat(LIVE_LINE_LIMITS.voiceCharacters - 4)}。${'い'.repeat(30)}。`;
    expect(cleanLiveLine(long, { voice: true })).toBe(`${'あ'.repeat(LIVE_LINE_LIMITS.voiceCharacters - 4)}。`);
    expect(cleanLiveLine('い'.repeat(LIVE_LINE_LIMITS.textCharacters + 5), { voice: false })).toBeNull();
  });
});

describe('LiveCommentary', () => {
  let clock = Date.parse('2026-10-20T10:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.parse('2026-10-20T10:00:00.000Z');
  });
  afterEach(() => vi.useRealTimers());

  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}, key = `${kind}:${clock}`): LiveMoment => ({ kind, key, at: clock, facts });

  function setup(options: { write?: (request: LiveWriteRequest) => Promise<string | null> } = {}) {
    const listeners = new Set<(moment: LiveMoment) => void>();
    const room = { replying: false, sinceHumanMilliseconds: null as number | null, danger: false };
    const outbox = new LiveSpeechOutbox(() => clock);
    // The body tells its room every poll (here every second of the fake timers), unless the test says it does not.
    const body = { told: true, voice: false };
    const refresh = () => { if (body.told) outbox.receive([], { voice: body.voice, humanSpeaking: false, sinceHumanMs: null }); };
    refresh();
    setInterval(refresh, 1000);
    const requests: LiveWriteRequest[] = [], delivered: Array<{ id: string; text: string; outcome: string; conversationId?: string }> = [], logs: string[] = [];
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.add(listener); return () => listeners.delete(listener); }, inDanger: () => room.danger,
        conversation: () => ({ replying: room.replying, sinceHumanMilliseconds: room.sinceHumanMilliseconds }) },
      outbox,
      write: async request => {
        requests.push(request);
        return options.write ? options.write(request) : `言葉:${request.main.kind}`;
      },
      delivered: told => delivered.push({ id: told.id, text: told.text, outcome: told.outcome, ...(told.conversationId ? { conversationId: told.conversationId } : {}) }),
      now: () => clock, log: line => logs.push(line),
    });
    engine.start();
    const emit = (item: LiveMoment) => listeners.forEach(listener => listener(item));
    const settle = async () => { await vi.advanceTimersByTimeAsync(10); };
    /** The body takes the line and says it. */
    const say = async (outcome: MinecraftLiveSpeechReceipt['outcome'] = 'spoken', conversationId?: string) => {
      const [line] = outbox.take();
      if (!line) return null;
      outbox.receive([{ id: line.id, outcome, ...(conversationId ? { conversationId } : {}) }], null);
      await settle();
      return line;
    };
    return { engine, emit, settle, say, room, outbox, requests, delivered, logs, body };
  }

  it('writes a line for a loud moment, hands it to the outbox, and keeps it as said once the body has said it', async () => {
    const f = setup();
    f.emit(moment('diamond_found', { count: 2 }));
    await f.settle();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.main.kind).toBe('diamond_found');
    expect(f.requests[0]?.voice).toBe(false);
    expect(f.outbox.pending()).toBe(1);
    const line = await f.say('posted', 'discord:1:2');
    expect(line?.text).toBe('言葉:diamond_found');
    expect(f.delivered).toEqual([{ id: line!.id, text: '言葉:diamond_found', outcome: 'posted', conversationId: 'discord:1:2' }]);
    expect(f.engine.governor.recentWords()).toEqual(['言葉:diamond_found']);
  });

  it('stays silent for a quiet moment, and drops it', async () => {
    const f = setup();
    f.emit(moment('morning'));
    await f.settle();
    expect(f.requests).toEqual([]);
    expect(f.engine.stats().dropped_salience).toBe(1);
    expect(f.engine.stats().waiting).toBe(0);
  });

  it('waits while someone is talking or a reply is being written, and speaks when the room is quiet', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 1_000;
    f.emit(moment('armor_complete'));
    await f.settle();
    expect(f.requests).toEqual([]);
    expect(f.engine.stats().held_human).toBeGreaterThan(0);
    f.room.replying = true;
    clock += 2_000;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toEqual([]);
    f.room.replying = false;
    f.room.sinceHumanMilliseconds = 20_000;
    clock += 2_000;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toHaveLength(1);
  });

  it('lets a moment that is too old go without a word', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 100;
    f.emit(moment('armor_complete'));
    await f.settle();
    clock += 70_000;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toEqual([]);
    expect(f.engine.stats().dropped_stale).toBe(1);
  });

  it('speaks of one moment at a time, the loudest, with the next two folded in', async () => {
    const f = setup();
    f.emit(moment('armor_complete'));
    f.emit(moment('dimension_entered', { dimension: 'the_nether' }));
    f.emit(moment('structure_found', { name: '村', distance: 100 }));
    f.emit(moment('slept'));
    await f.settle();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.main.kind).toBe('dimension_entered');
    expect(f.requests[0]?.also.map(item => item.kind)).toEqual(['armor_complete', 'structure_found']);
  });

  it('does not write a second line while the first has not been answered, then keeps the spacing', async () => {
    const f = setup();
    f.emit(moment('diamond_found'));
    await f.settle();
    f.emit(moment('dimension_entered', { dimension: 'the_nether' }));
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toHaveLength(1);
    await f.say();
    // Delivered just now: the gap holds the next one back; later it goes.
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toHaveLength(1);
    clock += 20_000;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    expect(f.requests).toHaveLength(2);
  });

  it('drops the moment when the model writes nothing, fails, takes too long, or repeats her last words', async () => {
    const answers = [null, 'throw', 'slow', '言葉:diamond_found'];
    let call = 0;
    const f = setup({ write: async () => {
      const answer = answers[call++];
      if (answer === 'throw') throw new Error('model down');
      if (answer === 'slow') return new Promise<string>(() => {});
      return answer ?? null;
    } });
    f.engine.governor.delivered(moment('diamond_found', {}, 'old'), '言葉:diamond_found', clock - 400_000);
    for (const kind of ['armor_complete', 'dimension_entered', 'structure_found', 'tool_made'] as const) {
      f.emit(moment(kind, kind === 'dimension_entered' ? { dimension: 'the_end' } : {}));
      await f.settle();
      await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.writeMilliseconds + 100);
      clock += 30_000;
    }
    expect(f.outbox.pending()).toBe(0);
    expect(f.engine.stats().write_empty).toBeGreaterThanOrEqual(3);
  });

  it('says nothing over someone who began to talk while the line was being written, and writes it again if the moment still stands', async () => {
    let release: (text: string) => void = () => {};
    const f = setup({ write: () => new Promise<string>(resolve => { release = resolve; }) });
    f.emit(moment('dimension_entered', { dimension: 'the_nether' }));
    await f.settle();
    f.room.sinceHumanMilliseconds = 500;
    release('入ったよ');
    await f.settle();
    expect(f.outbox.pending()).toBe(0);
    expect(f.engine.stats().write_held).toBe(1);
    f.room.sinceHumanMilliseconds = 30_000;
    clock += 2_000;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 10);
    release('入ったよ、ネザーだ');
    await f.settle();
    expect(f.outbox.pending()).toBe(1);
  });

  it('counts a line the body declined as nothing said', async () => {
    const f = setup();
    f.emit(moment('diamond_found'));
    await f.settle();
    await f.say('declined');
    expect(f.delivered).toEqual([]);
    expect(f.engine.governor.recentWords()).toEqual([]);
    expect(f.engine.stats().ended_declined).toBe(1);
  });

  it('writes for a voice channel when the body says it is in one', async () => {
    const f = setup();
    f.body.voice = true;
    f.outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: 60_000 });
    f.emit(moment('diamond_found'));
    await f.settle();
    expect(f.requests[0]?.voice).toBe(true);
  });

  it('writes nothing until the body has told its room, and then writes for the moment that still stands', async () => {
    const f = setup();
    f.body.told = false;
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(20);
    f.emit(moment('diamond_found'));
    await f.settle();
    expect(f.requests).toEqual([]);
    expect(f.engine.stats().held_no_body).toBeGreaterThan(0);
    f.body.told = true;
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.retryMilliseconds + 1_100);
    expect(f.requests).toHaveLength(1);
  });

  it('stops hearing moments after stop()', async () => {
    const f = setup();
    f.engine.stop();
    f.emit(moment('diamond_found'));
    await f.settle();
    expect(f.requests).toEqual([]);
  });
});

describe('the control carries her lines', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => databases.splice(0).forEach(db => db.close()));
  function fixture() {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
      servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
    const control = new MinecraftControl(new MinecraftControlStore(db), configuration, { now: Date.now, leaseValid: () => true, leaseKnown: () => true, ownerAlone: () => true });
    let sequence = 0;
    const scope = { scopeKey: 'owner', deviceId: 'minebot' };
    const poll = (patch: Partial<MinecraftControlPoll> = {}): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true,
        state: { world: { health: 20 } }, facts: { alive: true } },
      skills: [], candidates: [], receipts: [], activeOperationIds: [], ...patch });
    return { control, scope, poll };
  }

  it('tells the listeners each frame and each batch of events, and a new connection', () => {
    const f = fixture();
    const frames: Array<[string, boolean]> = [], batches: number[] = [];
    f.control.frameListeners.add((bodyId, _observation, arrival) => frames.push([bodyId, arrival.newConnection]));
    f.control.frameListeners.add(() => { throw new Error('a listener fails'); });
    f.control.eventListeners.add((_bodyId, events) => batches.push(events.length));
    const at = new Date().toISOString();
    const event = (seq: number) => ({ seq, at, kind: 'action.stalled', subject: `op${seq}`, data: { skill: 'mine-block', sinceProgressMs: 20_000 } });
    f.control.poll(f.scope, f.poll());
    f.control.poll(f.scope, f.poll({ events: [event(1), event(2)] }));
    f.control.poll(f.scope, f.poll({ events: [event(1), event(2), event(3)] }));
    f.control.poll(f.scope, f.poll({ connectionId: 'connection2', events: [event(1)] }));
    expect(frames).toEqual([['minecraft:world', true], ['minecraft:world', false], ['minecraft:world', false], ['minecraft:world', true]]);
    expect(batches).toEqual([2, 1, 1]);
  });

  it('reads the newest frame for a conversation up to an age, and none once it is older', async () => {
    const f = fixture();
    expect(f.control.latest('minecraft:world', 60_000)).toBeNull();
    f.control.poll(f.scope, f.poll());
    expect(f.control.latest('minecraft:world', 60_000)?.observation.state).toEqual({ world: { health: 20 } });
    expect(f.control.latest('minecraft:world', -1)).toBeNull();
    expect(f.control.latest('minecraft:other', 60_000)).toBeNull();
  });

  it('puts the line due in the reply, takes the body\'s answers and its room from the poll, and sends nothing without the outbox', () => {
    const f = fixture();
    expect(f.control.poll(f.scope, f.poll()).speech).toBeUndefined();
    const outbox = new LiveSpeechOutbox();
    f.control.speech = outbox;
    const ended: MinecraftLiveSpeechReceipt[] = [];
    outbox.onEnd(receipt => ended.push(receipt));
    outbox.enqueue(draft('a'));
    const reply = f.control.poll(f.scope, f.poll({ liveRoom: { voice: true, humanSpeaking: true, sinceHumanMs: 900 } }));
    expect(reply.speech?.map(item => item.id)).toEqual(['a']);
    expect(outbox.room()).toEqual({ voice: true, humanSpeaking: true, sinceHumanMs: 900 });
    const next = f.control.poll(f.scope, f.poll({ speechReceipts: [{ id: 'a', outcome: 'spoken', conversationId: 'discord:1:2' }] }));
    expect(next.speech).toBeUndefined();
    expect(ended).toEqual([{ id: 'a', outcome: 'spoken', conversationId: 'discord:1:2' }]);
  });

  it('validates the speech fields of a poll and refuses a malformed receipt or room', () => {
    const f = fixture(), now = Date.now();
    const ok = (patch: Partial<MinecraftControlPoll>) => validControlPoll(f.poll(patch), now);
    expect(ok({})).toBe(true);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'posted', conversationId: 'discord:12:34', reason: 'no_room' }], liveRoom: { voice: false, humanSpeaking: false, sinceHumanMs: null } })).toBe(true);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'sung' as never }] })).toBe(false);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'posted', conversationId: 'discord::34' }] })).toBe(true);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'posted', conversationId: 'discord:12' }] })).toBe(false);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'posted', conversationId: 'discord:1a:2' }] })).toBe(false);
    expect(ok({ speechReceipts: [{ id: 'a', outcome: 'declined', reason: 'Not Closed' }] })).toBe(false);
    expect(ok({ speechReceipts: 'no' as never })).toBe(false);
    expect(ok({ liveRoom: { voice: 'yes', humanSpeaking: false, sinceHumanMs: 0 } as never })).toBe(false);
    expect(ok({ liveRoom: { voice: true, humanSpeaking: false, sinceHumanMs: -5 } })).toBe(false);
  });
});
