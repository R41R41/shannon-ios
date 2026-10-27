import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MiniLibraryView, MiniPoseEntry, MiniVariant } from './miniPoseContract.js';

/**
 * The mini poses on disk, beside the database: `library.json` (the entries), `embeddings.json` (one vector per entry),
 * `images/<id>/<variant>.png`, `reference/` (the character sheet and her original picture, the drawings' references) and
 * `events.jsonl` (each choice and each drawing, with its seconds and cost: the hit rate and the drawing times are read from it).
 * Writes are whole-file and atomic; one process owns the folder.
 */
export type MiniEvent =
  | { kind: 'choose'; at: string; requestKey: string; source: 'library' | 'nearest' | 'empty'; poseId: string | null; jev: 'jev' | 'fallback' | 'skipped';
    candidates: number; ms: number; expression: string; contacts: string[]; drawing: boolean;
    /** Jev's probability that the reply shows a gesture no picture has. */
    missing?: number }
  | { kind: 'draw'; at: string; requestKey: string | null; poseId: string | null; ok: boolean; attempts: number; reason: string | null;
    notes?: string[]; seconds: Record<string, number>; costUsd: number }
  | { kind: 'retire'; at: string; poseId: string };

export class MiniPoseLibrary {
  private entries: MiniPoseEntry[] = [];
  private vectors = new Map<string, number[]>();
  private version = 0;

  constructor(readonly root: string) {
    mkdirSync(join(root, 'images'), { recursive: true });
    mkdirSync(join(root, 'reference'), { recursive: true });
    const library = join(root, 'library.json');
    if (existsSync(library)) {
      const parsed = JSON.parse(readFileSync(library, 'utf8')) as MiniLibraryView;
      this.entries = parsed.entries ?? [];
      this.version = parsed.version ?? 0;
    }
    const vectors = join(root, 'embeddings.json');
    if (existsSync(vectors)) this.vectors = new Map(Object.entries(JSON.parse(readFileSync(vectors, 'utf8')) as Record<string, number[]>));
  }

  view(): MiniLibraryView {
    return { version: this.version, entries: this.entries.map(entry => ({ ...entry })) };
  }

  get libraryVersion(): number { return this.version; }

  active(): MiniPoseEntry[] { return this.entries.filter(entry => !entry.retired); }

  get(id: string): MiniPoseEntry | null { return this.entries.find(entry => entry.id === id) ?? null; }

  vector(id: string): number[] | null { return this.vectors.get(id) ?? null; }

  imagePath(id: string, variant: MiniVariant): string { return join(this.root, 'images', id, `${variant}.png`); }

  reference(name: 'sheet' | 'original'): Uint8Array {
    return readFileSync(join(this.root, 'reference', `${name}.png`));
  }

  hasReferences(): boolean {
    return existsSync(join(this.root, 'reference', 'sheet.png')) && existsSync(join(this.root, 'reference', 'original.png'));
  }

  /** Writes the pictures first, then the entry: a reader never sees an entry whose pictures are missing. */
  add(entry: MiniPoseEntry, images: ReadonlyMap<MiniVariant, Uint8Array>, vector: number[]): void {
    mkdirSync(join(this.root, 'images', entry.id), { recursive: true });
    for (const [variant, bytes] of images) atomicWrite(this.imagePath(entry.id, variant), bytes);
    this.vectors.set(entry.id, vector);
    this.entries = [...this.entries.filter(item => item.id !== entry.id), entry];
    this.version++;
    this.save();
  }

  used(id: string, at: string): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.uses++;
    entry.lastUsedAt = at;
    // Use counts do not change what a client draws: the version stays, and they are saved with the next change or on a timer.
    this.dirty = true;
  }

  retire(id: string, at: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.retired) return false;
    entry.retired = true;
    this.version++;
    this.save();
    this.record({ kind: 'retire', at, poseId: id });
    return true;
  }

  private dirty = false;

  flush(): void { if (this.dirty) this.save(); }

  private save(): void {
    this.dirty = false;
    atomicWrite(join(this.root, 'library.json'), Buffer.from(JSON.stringify({ version: this.version, entries: this.entries }, null, 1)));
    atomicWrite(join(this.root, 'embeddings.json'), Buffer.from(JSON.stringify(Object.fromEntries(this.vectors))));
  }

  /** A drawing that was not kept, saved for the owner to look at (`rejected/`, newest names last). */
  reject(bytes: Uint8Array, why: string): void {
    try {
      mkdirSync(join(this.root, 'rejected'), { recursive: true });
      writeFileSync(join(this.root, 'rejected', `${new Date().toISOString().replace(/[:.]/g, '-')}-${why.replace(/[^\w-]/g, '_').slice(0, 60)}.png`), bytes);
    } catch { /* keeping a rejected picture never fails a drawing */ }
  }

  record(event: MiniEvent): void {
    try { appendFileSync(join(this.root, 'events.jsonl'), `${JSON.stringify(event)}\n`); } catch { /* a record never fails a turn */ }
  }

  events(): MiniEvent[] {
    const path = join(this.root, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as MiniEvent]; } catch { return []; } });
  }
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

export interface MiniStats {
  library: { poses: number; seed: number; generated: number; retired: number };
  choices: { total: number; library: number; hitRate: number | null; jevAnswered: number; drawingsAsked: number; medianMs: number | null };
  drawings: { total: number; ok: number; failed: number; medianSeconds: number | null; p90Seconds: number | null;
    stageMedians: Record<string, number>; costUsd: number };
  days: { day: string; choices: number; library: number; hitRate: number | null; drawings: number; costUsd: number }[];
}

const median = (values: number[], q = 0.5): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const rate = (hits: number, total: number) => (total ? Math.round((hits / total) * 1000) / 1000 : null);

/** The hit rate and the drawing times, overall and per day (the owner's request: both are recorded). */
export function miniStats(library: MiniPoseLibrary, since?: string): MiniStats {
  const events = library.events().filter(event => !since || event.at >= since);
  const choices = events.filter((event): event is Extract<MiniEvent, { kind: 'choose' }> => event.kind === 'choose');
  const draws = events.filter((event): event is Extract<MiniEvent, { kind: 'draw' }> => event.kind === 'draw');
  const okDraws = draws.filter(draw => draw.ok);
  const stages = new Set(okDraws.flatMap(draw => Object.keys(draw.seconds)));
  const days = new Map<string, { choices: number; library: number; drawings: number; costUsd: number }>();
  for (const event of [...choices, ...draws]) {
    const day = event.at.slice(0, 10), item = days.get(day) ?? { choices: 0, library: 0, drawings: 0, costUsd: 0 };
    if (event.kind === 'choose') { item.choices++; if (event.source === 'library') item.library++; }
    else { item.drawings++; item.costUsd += event.costUsd; }
    days.set(day, item);
  }
  const all = library.view().entries;
  return {
    library: { poses: all.filter(e => !e.retired).length, seed: all.filter(e => e.source === 'seed').length,
      generated: all.filter(e => e.source === 'generated').length, retired: all.filter(e => e.retired).length },
    choices: { total: choices.length, library: choices.filter(c => c.source === 'library').length,
      hitRate: rate(choices.filter(c => c.source === 'library').length, choices.length), jevAnswered: choices.filter(c => c.jev === 'jev').length,
      drawingsAsked: choices.filter(c => c.drawing).length, medianMs: median(choices.map(c => c.ms)) },
    drawings: { total: draws.length, ok: okDraws.length, failed: draws.length - okDraws.length,
      medianSeconds: median(okDraws.map(d => d.seconds.total ?? 0)), p90Seconds: median(okDraws.map(d => d.seconds.total ?? 0), 0.9),
      stageMedians: Object.fromEntries([...stages].map(stage => [stage, median(okDraws.map(d => d.seconds[stage] ?? 0)) ?? 0])),
      costUsd: Math.round(draws.reduce((sum, d) => sum + d.costUsd, 0) * 1000) / 1000 },
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, item]) => ({ day, ...item, hitRate: rate(item.library, item.choices),
      costUsd: Math.round(item.costUsd * 1000) / 1000 })),
  };
}
