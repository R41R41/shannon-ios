/**
 * What the server remembers of a voice channel for the next few minutes, in memory only (dc-voice, 2026-10-20): the talk she heard and
 * did not answer (people speaking to each other), the Minecraft situation her body's side described, and the filler she used last.
 * Nothing here is kept in her memory: a restart forgets it, and an expired line is dropped on the next read. What she says and what is
 * said to her is kept by the turn itself, in the platform thread.
 */
export interface HeardLine {
  userId: string;
  name: string;
  text: string;
  at: string;
}

export const VOICE_ROOM_LIMITS = Object.freeze({
  heardLines: 8,
  heardMinutes: 3,
  exchangeLines: 10,
  shannonMinutes: 10,
  lineCharacters: 160,
  situationCharacters: 300,
  situationDefaultMilliseconds: 60_000,
  situationMaximumMilliseconds: 10 * 60_000,
  rooms: 64,
});

/** One line of the talk in a room, said by a person or by her (owner 2026-10-21: the judgement of whom a line was said to reads it). */
export interface ExchangeLine {
  role: 'person' | 'shannon';
  userId: string;
  name: string;
  text: string;
  at: string;
}

/** Her last words in a room and whom they were for: the follow-up window of 「話しかけられたか」 opens from here. */
export interface ShannonSaid {
  /** When the words were written (the reply finished); she is still saying them for `speechMs` after. */
  at: string;
  userId: string;
  text: string;
  /** About how long saying them takes; the follow-up window is counted from the end of it when the body does not tell. */
  speechMs?: number;
}

/** About 130 ms a character for a spoken Japanese reply, at most 30 s. */
export const spokenMilliseconds = (characters: number): number => Math.min(30_000, Math.max(0, characters) * 130);

interface Room {
  heard: HeardLine[];
  exchange: ExchangeLine[];
  shannon: ShannonSaid | null;
  situation: { text: string; until: number } | null;
  fillerId: string | undefined;
  touched: number;
}

const clip = (text: string, length: number): string => Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, length).join('');

export class VoiceRooms {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly now: () => number = Date.now) {}

  private room(key: string): Room {
    let room = this.rooms.get(key);
    if (!room) {
      if (this.rooms.size >= VOICE_ROOM_LIMITS.rooms) {
        const oldest = [...this.rooms.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]?.[0];
        if (oldest !== undefined) this.rooms.delete(oldest);
      }
      room = { heard: [], exchange: [], shannon: null, situation: null, fillerId: undefined, touched: this.now() };
      this.rooms.set(key, room);
    }
    room.touched = this.now();
    return room;
  }

  /** Lines she heard and did not answer (or the body's side heard for her), newest last, never the same line twice. */
  noteHeard(key: string, lines: readonly HeardLine[]): void {
    const room = this.room(key);
    for (const line of lines) {
      const text = clip(line.text, VOICE_ROOM_LIMITS.lineCharacters);
      const at = Date.parse(line.at);
      if (!text || !Number.isFinite(at)) continue;
      if (room.heard.some(known => known.userId === line.userId && known.at === line.at && known.text === text)) continue;
      room.heard.push({ userId: line.userId, name: clip(line.name, 40) || '誰か', text, at: new Date(at).toISOString() });
    }
    room.heard.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.trim(room);
  }

  private trim(room: Room): void {
    const oldest = this.now() - VOICE_ROOM_LIMITS.heardMinutes * 60_000;
    room.heard = room.heard.filter(line => Date.parse(line.at) >= oldest).slice(-VOICE_ROOM_LIMITS.heardLines);
  }

  /** What she heard lately that was not said to her, newest last, without `exceptText` (the utterance being answered). */
  heard(key: string, exceptText?: string): HeardLine[] {
    const room = this.rooms.get(key);
    if (!room) return [];
    this.trim(room);
    return room.heard.filter(line => line.text !== exceptText);
  }

  /** A line of the talk, answered or not (people and she), newest last; the same line is kept once. */
  noteExchange(key: string, line: ExchangeLine): void {
    const room = this.room(key);
    const text = clip(line.text, VOICE_ROOM_LIMITS.lineCharacters);
    const at = Date.parse(line.at);
    if (!text || !Number.isFinite(at)) return;
    const when = new Date(at).toISOString();
    if (room.exchange.some(known => known.role === line.role && known.userId === line.userId && known.at === when && known.text === text)) return;
    room.exchange.push({ role: line.role, userId: line.userId, name: clip(line.name, 40) || '誰か', text, at: when });
    room.exchange.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const oldest = this.now() - VOICE_ROOM_LIMITS.heardMinutes * 60_000;
    room.exchange = room.exchange.filter(item => Date.parse(item.at) >= oldest).slice(-VOICE_ROOM_LIMITS.exchangeLines);
  }

  /** The talk of the last minutes, oldest first. */
  exchange(key: string): ExchangeLine[] {
    const room = this.rooms.get(key);
    if (!room) return [];
    const oldest = this.now() - VOICE_ROOM_LIMITS.heardMinutes * 60_000;
    room.exchange = room.exchange.filter(item => Date.parse(item.at) >= oldest);
    return [...room.exchange];
  }

  /** She spoke to `userId` (her reply, told when it is done). */
  noteShannon(key: string, said: ShannonSaid): void {
    const room = this.room(key);
    const text = clip(said.text, VOICE_ROOM_LIMITS.lineCharacters);
    room.shannon = { at: said.at, userId: said.userId, text, speechMs: said.speechMs ?? spokenMilliseconds(Array.from(said.text).length) };
    this.noteExchange(key, { role: 'shannon', userId: 'shannon', name: 'シャノン', text, at: said.at });
  }

  /** What she last said in this room, while it is still the talk of the moment (10 minutes). */
  lastShannon(key: string): ShannonSaid | null {
    const last = this.rooms.get(key)?.shannon;
    if (!last) return null;
    return this.now() - Date.parse(last.at) <= VOICE_ROOM_LIMITS.shannonMinutes * 60_000 ? last : null;
  }

  setSituation(key: string, text: string, ttlMilliseconds?: number): void {
    const body = clip(text, VOICE_ROOM_LIMITS.situationCharacters);
    const room = this.room(key);
    if (!body) {
      room.situation = null;
      return;
    }
    const ttl = Math.min(VOICE_ROOM_LIMITS.situationMaximumMilliseconds,
      Math.max(1_000, Number.isFinite(ttlMilliseconds) ? ttlMilliseconds! : VOICE_ROOM_LIMITS.situationDefaultMilliseconds));
    room.situation = { text: body, until: this.now() + ttl };
  }

  /** The situation a head-side caller set, while it is fresh. */
  situation(key: string): string | null {
    const room = this.rooms.get(key);
    if (!room?.situation) return null;
    if (this.now() > room.situation.until) {
      room.situation = null;
      return null;
    }
    return room.situation.text;
  }

  lastFiller(key: string): string | undefined { return this.rooms.get(key)?.fillerId; }

  useFiller(key: string, id: string | undefined): void { this.room(key).fillerId = id; }
}

export { clip as clipVoiceText };

/** The rooms of this server: the voice routes and head-side callers (`voiceMouth.setSituation`) share them. */
export const voiceRooms = new VoiceRooms();
