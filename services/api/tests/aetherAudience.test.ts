import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNLABELLED_DISCLOSURE_MARKER, createInitialCompanionState } from '@shannon/cognition';
import { LEFT_OUT_LINE, textForOthers } from '../src/aetherShownText.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/chatModel.js';
import { TOOLS_GUESTS_INSTRUCTIONS, TOOLS_OTHERS_INSTRUCTIONS, toolInstructions } from '../src/chatModelTools.js';
import { othersSecrets } from '../src/conversationSecrets.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/surfaces/platform/platformBridge.js';
import { PlatformPeople } from '../src/surfaces/platform/platformPeople.js';
import { PlatformReplyService } from '../src/surfaces/platform/platformReply.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteSurfaceTurnLog } from '../src/surfaces/minecraft/store/minecraftTurnStore.js';
import { conversationToolServer, conversationTools, type ConversationToolServer } from '../src/shannonToolSession.js';
import type { ToolExecutionContext } from '../src/shannonToolTypes.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/turnDeadline.js';
import { FakeAether } from './fakeAetherServer.js';

/**
 * Owner decisions of 2026-10-06 (Syzygy ADR-0007): a turn the owner did not speak or write (a friend in 「友人も一緒」,
 * someone else on a platform) is offered her Aether reading tools inside 「シャノン用フォルダ」 and nothing else; and what
 * she reads there in front of others reaches the model without what the owner told her alone.
 */
const scope = 'owner';
const at = '2026-10-06T01:00:00.000Z';
const SECRET = 'ウォンバット会の集まりに毎月出ている';
const HEALTH = '最近胃の調子が悪くて病院に通っている';
const NOTE = `今日はライ氏と灯台の話をした。ライ氏は${SECRET}らしい。ライ氏は${HEALTH}そうだ。\n灯台の光は夜に十二回まわる。`;
const servers: FakeAether[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.stop()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const state = { ...createInitialCompanionState(scope, at), userFacts: [
  { id: 'secret', statement: `ユーザーは${SECRET}`, confidence: 0.9, observedAt: at, disclosure: { category: 'secret' as const } },
  { id: 'health', statement: `ユーザーは${HEALTH}`, confidence: 0.9, observedAt: at, disclosure: { sensitivity: 'sensitive' as const, category: 'health' as const, decidedBy: 'rule' as const } },
  { id: 'tea', statement: 'ユーザーは紅茶が好きで毎朝ダージリンを飲む', confidence: 0.9, observedAt: at, disclosure: { sensitivity: 'ordinary' as const } },
] };

async function harness(options: { aether?: boolean } = {}) {
  const fake = new FakeAether();
  servers.push(fake);
  const access = options.aether === false ? null : await fake.access();
  const service = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now: () => at, aether: { access, proposals: null } });
  // The server of production, over this state: what the server knows of the audience, the secrets, the traces.
  const server: ConversationToolServer = conversationToolServer(null, { snapshot: () => state as never },
    { experienceCandidates: () => [], conversationHistory: () => [], recentMessages: () => [] }, () => at);
  const note = fake.put({ title: '灯台の話', body: NOTE, projectIds: ['project_shannon_folder'], tags: ['シャノン'], type: 'note' });
  const owners = fake.ownerDocument('ライ氏の灯台メモ', '灯台はライ氏の文書にもある。');
  const contexts: ToolExecutionContext[] = [];
  const call = service.tools.call.bind(service.tools);
  vi.spyOn(service.tools, 'call').mockImplementation((name, input, context, signal) => { contexts.push(context); return call(name, input, context, signal); });
  const turn = (ownerAlone: boolean | 'others' | 'guests' | 'shared', surface: 'text' | 'voice' = 'text', openOnly = false, words = 'シャノンのフォルダの灯台のメモを読んで') =>
    conversationTools(service, scope, surface, ownerAlone, server, `thread\n${words}`, new TurnDeadline(TEXT_TURN_DEADLINE), undefined, openOnly ? { openOnly: true } : {});
  return { fake, service, server, note, owners, contexts, turn };
}

const result = async (session: { call(name: string, argumentsJson: string): Promise<string> } | undefined, name: string, input: unknown) =>
  JSON.parse(await session!.call(name, JSON.stringify(input))) as { ok: boolean; text: string; failure?: string };

/** The run check of `conversationSecrets.ts` over these texts, as `othersSecrets` builds it. */
function runCheckOf(texts: readonly string[]) {
  const base = createInitialCompanionState(scope, at);
  return othersSecrets({ ...base, userFacts: texts.map((statement, index) => ({ id: `t${index}`, statement, confidence: 0.9, observedAt: at, disclosure: { category: 'secret' as const } })) } as never,
    { experienceCandidates: () => [] }, scope).withheld;
}

describe('a guest-only turn (owner decision 2026-10-06)', () => {
  it('gets exactly the three reading tools, with the others instruction, and only results inside her folder', async () => {
    const { turn, note, owners, contexts, server } = await harness();
    const open = vi.spyOn(server.turns, 'open');
    for (const [surface, openOnly] of [['text', true], ['voice', false]] as const) {
      const offered = turn('guests', surface, openOnly);
      expect(offered.toolsWithheld).toBeUndefined();
      expect(offered.tools!.definitions.map(tool => tool.name)).toEqual(['aether.search', 'aether.read', 'aetherFolder.list']);
      expect(offered.tools!.definitions.every(tool => tool.effect === 'read')).toBe(true);
      // Said without presuming the owner is there, and without naming his documents.
      expect(toolInstructions(offered.tools!, surface === 'voice')).toBe(TOOLS_GUESTS_INSTRUCTIONS);
      expect(TOOLS_GUESTS_INSTRUCTIONS).not.toContain('ライ氏の文書');
      expect(TOOLS_GUESTS_INSTRUCTIONS).not.toContain('二人だけ');
      expect(await result(offered.tools, 'aether_search', { query: '灯台' })).toMatchObject({ ok: false, failure: 'refused' });
      const found = await result(offered.tools, 'aether_search', { query: '灯台', scope: 'shannonFolder' });
      expect(found.text).toContain(note.id);
      expect(found.text).not.toContain(owners.id);
      expect(await result(offered.tools, 'aether_read', { documentId: owners.id })).toMatchObject({ ok: false, failure: 'refused' });
      expect(await result(offered.tools, 'aetherFolder_create', { title: 't', body: 'b' })).toMatchObject({ ok: false, failure: 'not_offered' });
      expect(await result(offered.tools, 'aether_propose', { operation: 'new-note', content: 'x' })).toMatchObject({ ok: false, failure: 'not_offered' });
    }
    // The audience that reaches the gate is `others`, with the check of what is shown to them; no trace is opened.
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context.audience).toBe('others');
      expect(context.othersText).toBeTruthy();
    }
    expect(contexts.map(context => context.othersText!.openOnly)).toContain(true);
    expect(contexts.map(context => context.othersText!.openOnly)).toContain(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('is given nothing and told nothing while Aether is not configured, exactly as a turn with no tools', async () => {
    const { turn, server } = await harness({ aether: false });
    const open = vi.spyOn(server.turns, 'open');
    for (const surface of ['text', 'voice'] as const) {
      expect(turn('guests', surface)).toEqual({});
      expect(turn('guests', surface, true)).toEqual(turn(false, surface, true));
    }
    // An owner turn with others present keeps its one withheld line, as on main.
    server.audience.noteOthers(scope);
    expect(turn(true)).toEqual({ toolsWithheld: true });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('what she reads of her folder in front of others', () => {
  it('removes the owner\'s secret and his personal matters with anyone else present; keeps all of it with him alone', async () => {
    const { turn, note } = await harness();
    const read = (offered: ReturnType<typeof turn>) => result(offered.tools, 'aether_read', { documentId: note.id });

    const alone = await read(turn(true));
    expect(alone.text).toContain(SECRET);
    expect(alone.text).toContain(HEALTH);
    expect(alone.text).not.toContain(LEFT_OUT_LINE);

    // The owner with others (voice and app text), and 「友人も一緒」: his secret and his health are both left out (「除く」, S-2).
    expect(toolInstructions(turn('others').tools!, false)).toBe(TOOLS_OTHERS_INSTRUCTIONS);
    // ADR-0007 revised: her works, unshown drafts included, may be read aloud with others present, without his approval first.
    for (const words of [TOOLS_OTHERS_INSTRUCTIONS, TOOLS_GUESTS_INSTRUCTIONS]) {
      expect(words).toContain('まだライ氏に見せていない下書きも、ここで読み上げたり話したりしてよい');
      expect(words).not.toContain('承認');
    }
    for (const offered of [turn('others'), turn('others', 'voice'), turn('shared'), turn('guests', 'voice')]) {
      const text = (await read(offered)).text;
      expect(text).not.toContain('ウォンバット');
      expect(text).not.toContain('胃の調子');
      expect(text).toContain('今日はライ氏と灯台の話をした。');
      expect(text).toContain('灯台の光は夜に十二回まわる。');
      expect(text).toContain(LEFT_OUT_LINE);
      // With him there, all of what she read is unlabelled derived text: marked as a whole, for the speak-time check.
      expect(text.startsWith(`${UNLABELLED_DISCLOSURE_MARKER}\n`)).toBe(true);
    }
    // Someone else's turn on a platform (openOnly): neither reaches the model, in a read or in a search hit.
    const guest = turn('guests', 'text', true);
    for (const shown of [await read(guest), await result(guest.tools, 'aether_search', { query: '灯台', scope: 'shannonFolder' })]) {
      expect(shown.ok).toBe(true);
      expect(shown.text).not.toContain('ウォンバット');
      expect(shown.text).not.toContain('胃の調子');
      expect(shown.text).toContain('灯台の話をした。');
      expect(shown.text).not.toContain(UNLABELLED_DISCLOSURE_MARKER);
    }
  });

  it('gives nothing read while the check cannot be read or is missing, and nothing of a text whose secret runs across sentences', async () => {
    const { turn, note, server, service, contexts } = await harness();
    vi.spyOn(server, 'othersText').mockImplementation(() => null);
    const unreadable = await result(turn('guests', 'text', true).tools, 'aether_read', { documentId: note.id });
    expect(unreadable).toMatchObject({ ok: false, failure: 'unavailable' });
    expect(unreadable.text).not.toContain('灯台');

    // A server that cannot say what must not be shown (no `othersText`) is one whose check could not be read.
    const partial: Partial<ConversationToolServer> = { audience: server.audience, secrets: server.secrets, now: () => at };
    const offered = conversationTools(service, scope, 'text', 'others', partial, 'thread\nシャノンのフォルダの灯台のメモを読んで', new TurnDeadline(TEXT_TURN_DEADLINE));
    const missing = await result(offered.tools, 'aether_read', { documentId: note.id });
    expect(missing).toMatchObject({ ok: false, failure: 'unavailable' });
    expect(missing.text).not.toContain('灯台');
    expect(contexts.at(-1)).toMatchObject({ audience: 'others', othersText: null });

    const check = { ...othersSecrets(state as never, { experienceCandidates: () => [] }, scope), openOnly: true };
    expect(textForOthers('灯台の光。紅茶が好きで毎朝ダージリンを飲む。', check)).toBe('灯台の光。紅茶が好きで毎朝ダージリンを飲む。');
    expect(textForOthers('ウォンバット会の集。まりに毎月出ている。', check)).toBeNull();
    // A marker put before a guarded sentence must not split a withheld run that crosses into it (review S-1).
    const crossing = { withheld: runCheckOf(['来月に手術。病院は東大病院']), guarded: runCheckOf(['病院は東大病院で入院予定']), openOnly: false };
    // Both sentences of his are left out (S-2), and so is the short sentence of his secret, matched whole (「除く」).
    expect(textForOthers('来月に手術。病院は東大病院で入院予定。', crossing)).toBe(LEFT_OUT_LINE);
    // An ordinary short sentence that is no sentence of a secret stays, even with words in common (「来月に」).
    expect(textForOthers('来月に旅行。来月に手術。灯台を見た。', crossing)).toBe(`来月に旅行。灯台を見た。\n${LEFT_OUT_LINE}`);
    // A secret written with another separator is cut there too: a space, an emoji, 、 (review of 2c95adff).
    for (const secret of ['来月に手術 病院は東大病院', '来月に手術🏥病院は東大病院', '来月に手術、病院は東大病院', '来月に手術．病院は東大病院']) {
      const separated = { withheld: runCheckOf([secret]), guarded: runCheckOf([]), openOnly: true };
      expect(textForOthers('ライ氏は来月に手術。灯台を見た。', separated)).toBe(`灯台を見た。\n${LEFT_OUT_LINE}`);
      // An ordinary sentence that only shares a short word of it (病院) stays.
      expect(textForOthers('病院の前を通った。', separated)).toBe('病院の前を通った。');
    }
    // The whole sentences stay beside the finer fragments: a clause under four characters does not let the sentence through.
    for (const [secret, folder] of [['来月、手術。病院は東大病院', '来月、手術。'], ['来月 手術。病院は東大病院', '来月 手術。']] as const) {
      const whole = { withheld: runCheckOf([secret]), guarded: runCheckOf([]), openOnly: true };
      expect(textForOthers(`${folder}灯台を見た。`, whole)).toBe(`灯台を見た。\n${LEFT_OUT_LINE}`);
    }
    // An emoji with a variation selector, a joiner or a modifier cuts cleanly (❤️, 👨‍⚕️, 👍🏽).
    for (const secret of ['来月に手術❤️病院は東大病院', '来月に手術👨‍⚕️病院は東大病院', '来月に手術👍🏽病院は東大病院']) {
      const emoji = { withheld: runCheckOf([secret]), guarded: runCheckOf([]), openOnly: true };
      expect(textForOthers('病院は東大病院。灯台を見た。', emoji)).toBe(`灯台を見た。\n${LEFT_OUT_LINE}`);
      expect(textForOthers('来月に手術❤️。灯台を見た。', emoji)).toBe(`灯台を見た。\n${LEFT_OUT_LINE}`);
    }
    // A sentence of a secret in hiragana alone is matched too; only short filler of a secret is skipped.
    const hiragana = { withheld: runCheckOf(['うつになった。そうなんだ。病院は東大病院']), guarded: runCheckOf([]), openOnly: true };
    expect(textForOthers('ライ氏はうつになった。灯台を見た。', hiragana)).toBe(`灯台を見た。\n${LEFT_OUT_LINE}`);
    expect(textForOthers('そうなんだ。灯台を見た。', hiragana)).toBe('そうなんだ。灯台を見た。');
  });
});

/** A model that reads one document of her folder when it is offered her tools, and keeps what it was given. */
class ReadingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly read: string[] = [];
  documentId = '';
  async generateVoice(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { return this.generate(request); }
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    if (request.tools && this.documentId) this.read.push(await request.tools.call('aether_read', JSON.stringify({ documentId: this.documentId })));
    return { mode: this.mode, model: this.model, reply: 'はい。' };
  }
}

describe('turns with others present on a platform and in app text (owner decisions 2026-10-06)', () => {
  it('offer her folder reading with Aether, without the owner\'s secret, marked where he is there; without Aether nothing, as before', async () => {
    const BINDINGS = [{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '900000000000000001', title: 'テストサーバー' }];
    const environment = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'b'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: scope, SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
    for (const configured of [true, false]) {
      const directory = mkdtempSync(join(tmpdir(), 'shannon-aether-audience-'));
      directories.push(directory);
      const path = join(directory, 'shannon.sqlite');
      const now = () => at;
      const store = new SQLiteShannonStore({ path, now });
      const peopleStore = new SQLitePeopleMemoryStore(path);
      const background = new BackgroundUpdateCoordinator(store, store);
      const fake = new FakeAether();
      servers.push(fake);
      const autonomyStore = new SQLiteAutonomyStore(':memory:');
      const autonomy = new ShannonAutonomyService({ store: autonomyStore, config: configuredAutonomy({}), now, aether: { access: configured ? await fake.access() : null, proposals: null } });
      const model = new ReadingModel();
      const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore, autonomy });
      const bridge = new PlatformBridgeService(configuredPlatformBridge(environment)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
      const turns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
      const service = new PlatformReplyService({ scopeKey: scope, bridge, conversationStore: store, conversation: api, turns, now });
      // What the owner told her alone, and her note that repeats his words (a run of ten characters; a retelling in other words is not caught).
      await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'app-talk', message: 'これは内緒だけど、来月転職するつもり' } });
      await api.waitForBackground(scope);
      model.documentId = fake.put({ title: '今日のこと', body: 'ライ氏が「これは内緒だけど、来月転職するつもり」と話してくれた。灯台の本を読んだ。', projectIds: ['project_shannon_folder'], tags: ['シャノン'], type: 'note' }).id;
      const turnsWithOthers: Array<[string, boolean, () => Promise<unknown>]> = [
        // Someone else's turn (openOnly): his private things are left out, and nothing is marked.
        ['friend', false, () => service.reply({ platform: 'discord', requestId: `f-${configured}`, conversationId: 'discord:111:222', conversationKind: 'channel',
          sourceUserId: '900000000000000002', sourceDisplayName: 'ミキ', userMessage: 'シャノンのメモに何が書いてある？', observedAt: now() })],
        // The owner's own turn in the shared channel, and his app text marked `others`: left out, and marked as a whole.
        ['owner shared', true, () => service.reply({ platform: 'discord', requestId: `o-${configured}`, conversationId: 'discord:111:222', conversationKind: 'channel',
          sourceUserId: '900000000000000001', userMessage: 'シャノンのメモに何が書いてある？', observedAt: now() })],
        ['app others', true, () => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'app-talk', message: 'シャノンのメモに何が書いてある？', audience: 'others' } })],
      ];
      for (const [, ownerThere, send] of turnsWithOthers) {
        model.read.length = 0;
        await send();
        const request = model.requests.at(-1)!;
        if (configured) {
          expect(request.tools!.definitions.map(tool => tool.name)).toEqual(['aether.search', 'aether.read', 'aetherFolder.list']);
          expect(toolInstructions(request.tools!, false)).toBe(ownerThere ? TOOLS_OTHERS_INSTRUCTIONS : TOOLS_GUESTS_INSTRUCTIONS);
          expect(model.read).toHaveLength(1);
          const shown = (JSON.parse(model.read[0]!) as { text: string }).text;
          expect(shown).toContain('灯台の本を読んだ。');
          expect(shown).not.toContain('転職');
          expect(shown.startsWith(`${UNLABELLED_DISCLOSURE_MARKER}\n`)).toBe(ownerThere);
        } else {
          expect(request.tools).toBeUndefined();
          expect(request.toolsWithheld).toBeUndefined();
        }
        await background.waitForIdle(scope);
      }
      // No trace of these reads is kept to replay: every turn was stored with others as its audience.
      expect(store.toolTraces(scope, null, { since: '2000-01-01T00:00:00.000Z' })).toEqual([]);
      turns.close(); autonomyStore.close(); peopleStore.close(); store.close();
    }
  });
});

describe('a friend in 「友人も一緒」 (voice)', () => {
  it('is offered her folder reading with Aether, his secret left out; a client that predates people memory is offered nothing', async () => {
    const fake = new FakeAether();
    servers.push(fake);
    const now = () => at;
    const autonomy = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now, aether: { access: await fake.access(), proposals: null } });
    const model = new ReadingModel();
    const api = createLocalApiKernel(now, { chatModel: model, autonomy });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'talk', message: 'これは内緒だけど、来月転職するつもり' } });
    await api.waitForBackground(scope);
    model.documentId = fake.put({ title: '今日のこと', body: 'ライ氏が「これは内緒だけど、来月転職するつもり」と話してくれた。灯台の本を読んだ。', projectIds: ['project_shannon_folder'], tags: ['シャノン'], type: 'note' }).id;
    const say = (transcript: string, callContext: boolean) => api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: scope, threadId: 'talk', transcript, participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `u-${callContext}`, text: transcript, source: 'speech', rawText: transcript,
          ...(callContext ? { callContext: { callId: 'call-audience-0001', turns: [], introductionStart: true } } : {}) } } } });
    expect((await say('シャノンのフォルダに何があるの？', true)).status).toBe(200);
    expect(model.requests.at(-1)!.tools!.definitions.map(tool => tool.name)).toEqual(['aether.search', 'aether.read', 'aetherFolder.list']);
    expect(model.read.at(-1)).toContain('灯台の本を読んだ。');
    expect(model.read.at(-1)).not.toContain('転職');
    expect((await say('シャノンのフォルダに何があるの？', false)).status).toBe(200);
    expect(model.requests.at(-1)!.tools).toBeUndefined();
    expect(model.requests.at(-1)!.toolsWithheld).toBeUndefined();
  });
});
