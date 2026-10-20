import { describe, expect, it } from 'vitest';
import { ElevenSpeechError, ElevenSpeechGateway, validatedElevenTags } from '../src/infra/models/elevenSpeech.js';

class FakeSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, Set<(event: Event) => void>>();

  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void) {
    const entries = this.handlers.get(type) ?? new Set();
    entries.add(listener);
    this.handlers.set(type, entries);
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void) {
    this.handlers.get(type)?.delete(listener);
  }
  emit(type: string, payload?: unknown) {
    const event = Object.assign(new Event(type), { data: payload });
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  listenerCount() { return [...this.handlers.values()].reduce((count, entries) => count + entries.size, 0); }
}

const request = { scopeKey: 'synthetic-owner', text: 'ふふ、任せて。', style: '[playful, lightly mischievous]' };

describe('Eleven v4 Turbo speech', () => {
  it('sends a single selected voice, acting tags, and flushes a short Japanese reply', async () => {
    const socket = new FakeSocket();
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket });
    const speech = await gateway.stream(request);
    const collected = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of speech.chunks) chunks.push(chunk);
      return chunks;
    })();
    socket.emit('open');
    await Promise.resolve();
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ voices: ['testvoice123'] });
    expect(JSON.parse(socket.sent[1] ?? '{}').inputs[0]).toMatchObject({
      voice_id: 'testvoice123', text: '[playful, lightly mischievous] ふふ、任せて。',
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ close_socket: true });
    socket.emit('message', JSON.stringify({ audio: Buffer.from([1, 2, 3, 4]).toString('base64') }));
    socket.emit('message', JSON.stringify({ is_final: true }));
    expect((await collected).map(chunk => [...chunk])).toEqual([[1, 2, 3, 4]]);
    expect(socket.closed).toBe(true);
    expect(socket.listenerCount()).toBe(0);
  });

  it('rejects incomplete output instead of accepting a premature close', async () => {
    const socket = new FakeSocket();
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket });
    const speech = await gateway.stream(request);
    const next = speech.chunks[Symbol.asyncIterator]().next();
    socket.emit('close');
    await expect(next).rejects.toMatchObject({ code: 'ELEVEN_SPEECH_FAILED' });
  });

  it('cancels the upstream socket and removes listeners', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket });
    const speech = await gateway.stream(request, controller.signal);
    const next = speech.chunks[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(socket.closed).toBe(true);
    expect(socket.listenerCount()).toBe(0);
  });

  it('keeps her listed audio tags inside the sentence and drops any other bracketed direction', async () => {
    const socket = new FakeSocket();
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket });
    const speech = await gateway.stream({ ...request, text: 'ねえ、[whispers] 内緒だよ。[smiles] [laughs] ほんと。' });
    const next = speech.chunks[Symbol.asyncIterator]().next();
    socket.emit('open');
    await Promise.resolve();
    expect(JSON.parse(socket.sent[1] ?? '{}').inputs[0].text)
      .toBe('[playful, lightly mischievous] ねえ、 [whispers] 内緒だよ。 [laughs] ほんと。');
    socket.emit('message', JSON.stringify({ audio: Buffer.from([1, 2]).toString('base64') }));
    socket.emit('message', JSON.stringify({ is_final: true }));
    await next;
  });

  it('says a tag once when the sentence opens with one the acting tags already have', async () => {
    const socket = new FakeSocket();
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket });
    const speech = await gateway.stream({ ...request, style: '[anime character] [whispers]', text: '[whispers] [giggles] 内緒だよ。' });
    const next = speech.chunks[Symbol.asyncIterator]().next();
    socket.emit('open');
    await Promise.resolve();
    expect(JSON.parse(socket.sent[1] ?? '{}').inputs[0].text).toBe('[anime character] [whispers] [giggles] 内緒だよ。');
    socket.emit('message', JSON.stringify({ audio: Buffer.from([1, 2]).toString('base64') }));
    socket.emit('message', JSON.stringify({ is_final: true }));
    await next;
  });

  it('accepts acting tags only, keeping instructions and markup out of spoken text', () => {
    expect(validatedElevenTags('[bright, warm conversational voice]')).toBe('[bright, warm conversational voice] ');
    expect(() => validatedElevenTags('Speak with a smile.')).toThrow(ElevenSpeechError);
    expect(() => validatedElevenTags('[smiling]<xml>')).toThrow(ElevenSpeechError);
  });
});
