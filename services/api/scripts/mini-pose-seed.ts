/**
 * Draws the first mini pose library (owner 2026-10-28). Usage:
 *   OPENAI_API_KEY=… tsx scripts/mini-pose-seed.ts <library folder> <character sheet.png> <original.png> [--only id,id] [--concurrency 4]
 * The two references are copied into the folder; poses already in it are skipped, so a stopped run continues where it stopped.
 * Each drawing's seconds and cost are recorded in the folder's events.jsonl like a reply's.
 */
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniPoseGenerator, SHEET_4, SHEET_8 } from '../src/surfaces/mini/miniPoseGenerator.js';
import { MiniPoseLibrary, miniStats } from '../src/surfaces/mini/miniPoseLibrary.js';
import { OpenAIMiniModels } from '../src/surfaces/mini/miniPoseModels.js';
import { MINI_SEED_SPECS } from '../src/surfaces/mini/miniPoseSeeds.js';

const [root, sheet, original, ...rest] = process.argv.slice(2);
if (!root || !sheet || !original) throw new Error('usage: mini-pose-seed <folder> <sheet.png> <original.png> [--only ids] [--concurrency n]');
const flag = (name: string) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
const only = flag('--only')?.split(',');
/** `--redo-variants id,id`: draw the face variants of these kept poses again (their base stays). */
const redo = flag('--redo-variants')?.split(',');
/** `--measure id,id|all`: measure the head (and a carried picture's hold) of these kept poses again. */
const measure = flag('--measure');
/** `--redo-walk id,id`: draw the walk cycle of these kept walks again. */
const redoWalk = flag('--redo-walk')?.split(',');
/** `--walk-frames 4`: draw the old four-frame cycle (eight by default). */
const walkLayout = flag('--walk-frames') === '4' ? SHEET_4 : SHEET_8;
const concurrency = Number(flag('--concurrency') ?? 4);

const library = new MiniPoseLibrary(root);
copyFileSync(sheet, join(root, 'reference', 'sheet.png'));
copyFileSync(original, join(root, 'reference', 'original.png'));
const generator = new MiniPoseGenerator({ library, models: new OpenAIMiniModels({ apiKey: process.env.OPENAI_API_KEY ?? '' }) });
if (measure) {
  const ids = measure === 'all' ? library.active().map(entry => entry.id) : measure.split(',');
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!, kept = await generator.remeasure(id);
      console.log(`${id} ${kept?.head ? `head ${kept.head.bottom - kept.head.top}px${kept.grip ? ` grip ${kept.anchor.x},${kept.anchor.y}` : ''}` : 'FAILED'}`);
    }
  }));
  process.exit(0);
}
if (redoWalk) {
  for (const id of redoWalk) {
    const outcome = await generator.redoWalk(id, walkLayout);
    library.record({ kind: 'draw', at: new Date().toISOString(), requestKey: null, poseId: outcome.entry?.id ?? null, ok: outcome.entry !== null,
      attempts: outcome.attempts, reason: outcome.reason, notes: outcome.notes, seconds: outcome.seconds, costUsd: outcome.costUsd });
    console.log(`${id} ${outcome.entry ? `ok ${outcome.entry.variants.join('+')}` : `FAILED ${outcome.reason}`} $${outcome.costUsd.toFixed(3)} ${JSON.stringify(outcome.seconds)} ${outcome.notes.join(';')}`);
  }
  process.exit(0);
}
if (redo) {
  for (const id of redo) {
    const outcome = await generator.redoVariants(id);
    library.record({ kind: 'draw', at: new Date().toISOString(), requestKey: null, poseId: outcome.entry?.id ?? null, ok: outcome.entry !== null,
      attempts: outcome.attempts, reason: outcome.reason, notes: outcome.notes, seconds: outcome.seconds, costUsd: outcome.costUsd });
    console.log(`${id} ${outcome.entry ? `ok ${outcome.entry.variants.join('+')}` : `FAILED ${outcome.reason}`} $${outcome.costUsd.toFixed(3)} ${outcome.notes.join(';')}`);
  }
  process.exit(0);
}
const todo = MINI_SEED_SPECS.filter(spec => (!only || only.includes(spec.id)) && !library.get(spec.id));
console.log(`${todo.length} poses to draw`);

let next = 0, done = 0;
async function worker() {
  while (next < todo.length) {
    const spec = todo[next++]!;
    const started = performance.now();
    try {
      const outcome = await generator.draw(spec, { source: 'seed', requestKey: null, id: spec.id });
      const total = (performance.now() - started) / 1000;
      library.record({ kind: 'draw', at: new Date().toISOString(), requestKey: null, poseId: outcome.entry?.id ?? null, ok: outcome.entry !== null,
        attempts: outcome.attempts, reason: outcome.reason, notes: outcome.notes, seconds: { ...outcome.seconds, total: Math.round(total * 10) / 10 }, costUsd: outcome.costUsd });
      console.log(`${++done}/${todo.length} ${spec.id} ${outcome.entry ? `ok ${outcome.entry.variants.join('+')}` : `FAILED ${outcome.reason}`} `
        + `${total.toFixed(1)}s $${outcome.costUsd.toFixed(3)} tries=${outcome.attempts}${outcome.notes.length ? ` notes=${outcome.notes.join(';')}` : ''}`);
    } catch (error) {
      console.log(`${++done}/${todo.length} ${spec.id} ERROR ${error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)}`);
      library.record({ kind: 'draw', at: new Date().toISOString(), requestKey: null, poseId: null, ok: false, attempts: 0,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'error', seconds: { total: (performance.now() - started) / 1000 }, costUsd: 0 });
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
console.log(JSON.stringify(miniStats(library).drawings, null, 1));
