import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { lookContextReader } from '../src/surfaces/body/lookContext.js';
import { guestPhotoContext } from '../src/surfaces/voice/serverVoiceVisionRoute.js';
import { imageSize, visionLook } from '../src/mind/perception/perceptionPorts.js';
import { VisionNoticeSpeaker, visionNoticeInstructions } from '../src/surfaces/vision/visionNotice.js';
import { VisionEscalation } from '../src/surfaces/vision/visionEscalate.js';
import type { MindEvent } from '@shannon/mind';

// Syzygy ADR-0011 §11 slice 6 (the holes of `shannon-information-inputs.md`) and the absolute rule: an audience change must not
// leak private context, and what the owner asked to forget is never given to a model that sees a frame.
const minute = (value: number) => new Date(Date.UTC(2026, 9, 14, 0, value)).toISOString();
const forgetAt = minute(500);
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const turnContext = () => ({ capturedStateVersion: 0, messageEmotion: emotion });

function talk() {
  const state = new InMemoryCompanionStateStore(() => forgetAt);
  const history = new InMemoryConversationStore(400, 1_000, 400);
  history.appendTurn('owner', 'thread-a', 'Xcodeのビルドが通らない', '署名設定を確認しましょう。', minute(1), turnContext());
  const source = history.appendTurn('owner', 'thread-a', '私は紅茶が好き。', '紅茶が好きなんですね。', minute(2), turnContext());
  new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
  return { state, history, fact: state.snapshot('owner').userFacts[0]! };
}

describe('a look\'s model is told the Talk only under the audience and forgetting of now', () => {
  it('re-feeds no forgotten turn (shannonBody.ts:125,128 used the raw history)', () => {
    const { state, history, fact } = talk();
    let alone = true;
    const read = lookContextReader({ stateStore: state, conversationStore: history, alone: () => alone });
    expect(read('owner', 'thread-a').map(line => line.content).join('\n')).toContain('紅茶');
    new ShannonMemoryService(state, history, () => forgetAt).mutate('owner', { memoryId: fact.id, action: 'forget' });
    const after = read('owner', 'thread-a').map(line => line.content).join('\n');
    expect(after).not.toContain('紅茶');
    expect(after).toContain('署名設定');
    alone = false;
    expect(read('owner', 'thread-a')).toEqual([]);
  });

  it('gives a shared photo only a guest\'s context while anyone else may be present (serverVoiceVisionRoute.ts:36-43)', () => {
    const context = guestPhotoContext();
    expect(context.length).toBeGreaterThan(0);
    expect(context).not.toContain('[Recent conversation]');
    expect(context).not.toContain('[ユーザーについて');
  });
});

describe('the common look record', () => {
  it('describes a used frame without its picture, and sends one closed percept', () => {
    const events: MindEvent[] = [];
    const frame = visionLook({ scopeKey: 'owner', source: 'app_look', purpose: 'owner_asked', deviceId: 'device-1', outcome: 'seen', audience: 'owner_alone',
      at: minute(3), image: { format: 'jpeg', byteLength: 1_000, width: 720, height: 960 },
      perceiver: { perceive: (_scope, event) => { if (event) events.push(event); return null; } } });
    expect(frame).toMatchObject({ schema: 'vision.frame.v1', privacy: 'owner_private', source: { kind: 'app_look' }, encoding: { width: 720 } });
    expect(JSON.stringify(frame)).not.toMatch(/base64|image\b|persist/u);
    expect(events.map(event => [event.kind, event.percept?.privacy, event.audience.kind])).toEqual([['percept', 'owner_private', 'owner']]);
    const shared = visionLook({ scopeKey: 'owner', source: 'photo', purpose: 'shared_photo', deviceId: null, outcome: 'seen', audience: 'others',
      at: minute(3), image: null, perceiver: { perceive: (_scope, event) => { if (event) events.push(event); return null; } } });
    expect(shared).toBeNull();
    expect(events[1]?.percept?.privacy).toBe('shared_room');
    expect(events[1]?.presence.othersMayHear).toBe(true);
  });

  it('reads a JPEG\'s and a PNG\'s size from the header only', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x80, 0x02, 0x00, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 512, height: 384 });
    const png = Buffer.alloc(32);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.writeUInt32BE(256, 16);
    png.writeUInt32BE(192, 20);
    expect(imageSize(png)).toEqual({ width: 256, height: 192 });
  });
});

describe('a camera notice and an escalation are said only with the owner alone', () => {
  const base = { compose: async () => 'おかえりなさい、ライ氏。', ownerLastActiveAt: () => null, now: () => Date.parse(minute(10)) };

  it('checks the audience before and after the words are made, holds while he talks, and drops a stale notice', async () => {
    const said: string[] = [];
    let alone = true;
    const speaker = new VisionNoticeSpeaker({ ...base, alone: () => alone, say: (_s, _d, text) => { said.push(text); return { threadId: 't' }; },
      compose: async () => { alone = false; return 'おかえりなさい、ライ氏。'; } });
    expect(await speaker.deliver({ scopeKey: 'owner', decisionId: 'd1', category: 'owner_returned', at: minute(10) })).toEqual({ delivered: false, reason: 'others' });
    alone = true;
    const ok = new VisionNoticeSpeaker({ ...base, alone: () => true, say: (_s, _d, text) => { said.push(text); return { threadId: 't' }; } });
    expect(await ok.deliver({ scopeKey: 'owner', decisionId: 'd2', category: 'owner_returned', at: minute(10) })).toEqual({ delivered: true, threadId: 't' });
    expect(await ok.deliver({ scopeKey: 'owner', decisionId: 'd3', category: 'owner_returned', at: minute(9) })).toEqual({ delivered: false, reason: 'stale' });
    expect(await ok.deliver({ scopeKey: 'owner', decisionId: 'd4', category: 'read_the_screen', at: minute(10) })).toEqual({ delivered: false, reason: 'invalid' });
    const talking = new VisionNoticeSpeaker({ ...base, alone: () => true, ownerLastActiveAt: () => new Date(Date.parse(minute(10)) - 5_000).toISOString(),
      say: () => ({ threadId: 't' }) });
    expect(await talking.deliver({ scopeKey: 'owner', decisionId: 'd5', category: 'owner_returned', at: minute(10) })).toEqual({ delivered: false, reason: 'owner_active' });
    expect(said).toEqual(['おかえりなさい、ライ氏。']);
    expect(visionNoticeInstructions('owner_returned')).toContain('画面や書類の文字を読み上げず');
  });

  it('shows an escalated frame to the look model with no Talk context, and says nothing once others are present', async () => {
    const requests: Array<{ context: readonly unknown[] }> = [];
    let alone = true;
    const looks: string[] = [];
    const escalation = new VisionEscalation({
      viewer: { see: async request => { requests.push(request); alone = false; return 'ライ氏、それは新しいマグですね。'; } },
      alone: () => alone, say: () => ({ threadId: 't' }), looked: (_scope, look) => { looks.push(look.outcome); }, now: () => Date.parse(minute(10)),
    });
    const result = await escalation.look({ scopeKey: 'owner', decisionId: 'd1', deviceId: 'device-1', mimeType: 'image/jpeg', base64: 'AAAA', width: 512,
      height: 384, at: minute(10) });
    expect(result).toEqual({ seen: false });
    expect(requests.map(request => request.context)).toEqual([[]]);
    expect(looks).toEqual(['withheld']);
  });
});
