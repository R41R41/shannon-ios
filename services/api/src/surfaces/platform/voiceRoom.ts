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
  lineCharacters: 160,
  situationCharacters: 300,
  situationDefaultMilliseconds: 60_000,
  situationMaximumMilliseconds: 10 * 60_000,
  rooms: 64,
});

interface Room {
  heard: HeardLine[];
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
      room = { heard: [], situation: null, fillerId: undefined, touched: this.now() };
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
