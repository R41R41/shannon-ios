import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import { changedRegion, GUIDE_EDGE, guideFor, keyGreen, MINI_CANVAS, onWindow, takeRegions } from '../src/surfaces/mini/miniImage.js';
import { MiniPoseChooser, miniPoseQuestions } from '../src/surfaces/mini/miniPoseChooser.js';
import type { MiniPoseEntry } from '../src/surfaces/mini/miniPoseContract.js';
import { drawPrompt, figureSpans, MiniPoseGenerator, shapeBase } from '../src/surfaces/mini/miniPoseGenerator.js';
import { MiniPoseLibrary, miniStats } from '../src/surfaces/mini/miniPoseLibrary.js';
import type { MiniModels } from '../src/surfaces/mini/miniPoseModels.js';
import { MINI_SEED_SPECS } from '../src/surfaces/mini/miniPoseSeeds.js';
import { parsedChooseRequest } from '../src/surfaces/mini/miniPoseRoutes.js';
import { blankImage, decodePng, encodePng, type RgbaImage } from '../src/surfaces/mini/png.js';

/**
 * The mini poses (owner 2026-10-28). The image model, the reading model and Jev are stood in for: what is measured is ours, the
 * picture work (keying, the edge, taking only the changed face back), the library and its records, and the choice around Jev.
 */
const folders: string[] = [];
afterEach(() => { while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true }); });
const folder = () => { const path = mkdtempSync(join(tmpdir(), 'mini-')); folders.push(path); return path; };

function paint(image: RgbaImage, box: [number, number, number, number], rgba: [number, number, number, number]): void {
  for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) image.data.set(rgba, (y * image.width + x) * 4);
}

/** A stand-in drawing: the green board (moved up, as the model does) and a figure sitting on it. */
function seated(edge = 580): RgbaImage {
  const image = blankImage(MINI_CANVAS, MINI_CANVAS);
  paint(image, [118, edge, 906, MINI_CANVAS - 1], [0, 250, 10, 255]);
  paint(image, [400, 150, 620, edge + 200], [120, 170, 240, 255]); // her
  paint(image, [470, 300, 550, 340], [250, 220, 210, 255]); // her face
  return image;
}

describe('png', () => {
  it('writes and reads back the same pixels', () => {
    const image = seated();
    const back = decodePng(encodePng(image));
    expect(back.width).toBe(MINI_CANVAS);
    expect(Buffer.from(back.data).equals(Buffer.from(image.data))).toBe(true);
  });
});

describe('the picture work', () => {
  it('keys out the board and measures the edge where the model left it', () => {
    const keyed = keyGreen(seated(577));
    expect(keyed.edge).toBe(577);
    // The board is gone, she stays.
    expect(keyed.image.data[(800 * MINI_CANVAS + 200) * 4 + 3]).toBe(0);
    expect(keyed.image.data[(700 * MINI_CANVAS + 500) * 4 + 3]).toBe(255);
  });

  it('anchors a sitting pose at the measured edge and a hang at the top of the fists', () => {
    const sit = shapeBase(seated(560), 'sit');
    expect('anchor' in sit && sit.anchor).toEqual({ x: 510, y: 560 });
    const hang = blankImage(MINI_CANVAS, MINI_CANVAS);
    paint(hang, [450, 100, 570, 800], [120, 170, 240, 255]);
    const shaped = shapeBase(hang, 'hang');
    expect('anchor' in shaped && shaped.anchor.y).toBe(100 + Math.round(700 * 0.035));
  });

  it('refuses a figure cut off by the canvas or one with no board', () => {
    const cut = blankImage(MINI_CANVAS, MINI_CANVAS);
    paint(cut, [0, 100, 300, 900], [120, 170, 240, 255]);
    expect(shapeBase(cut, 'air')).toEqual({ reason: 'cut_off' });
    const plain = blankImage(MINI_CANVAS, MINI_CANVAS);
    paint(plain, [400, 100, 600, 900], [120, 170, 240, 255]);
    expect(shapeBase(plain, 'sit')).toEqual({ reason: 'no_edge' });
  });

  it('takes only the changed face of an edit back, keeping her outline, even when the edit lost the transparent background', () => {
    const base = keyGreen(seated()).image;
    const edited = new Uint8ClampedArray(base.data);
    // The edit came back opaque (a grey background) with the mouth changed.
    const opaque: RgbaImage = { width: base.width, height: base.height, data: edited };
    for (let i = 0; i < edited.length; i += 4) if (edited[i + 3] === 0) { edited.set([90, 90, 90, 255], i); }
    paint(opaque, [495, 320, 525, 335], [200, 40, 60, 255]);
    const region = changedRegion(base, opaque);
    expect(region).not.toBeNull();
    expect(region!.share).toBeLessThan(0.05);
    const merged = takeRegions(base, [{ image: opaque, region: region! }]);
    expect(Array.from(merged.data.subarray((327 * MINI_CANVAS + 510) * 4, (327 * MINI_CANVAS + 510) * 4 + 4))).toEqual([200, 40, 60, 255]);
    // Outside her, still transparent; far from the face, untouched.
    expect(merged.data[(50 * MINI_CANVAS + 50) * 4 + 3]).toBe(0);
    expect(Array.from(merged.data.subarray((700 * MINI_CANVAS + 500) * 4, (700 * MINI_CANVAS + 500) * 4 + 4))).toEqual([120, 170, 240, 255]);
  });

  it('draws the stand-in window under her for the inspector', () => {
    const shown = onWindow(keyGreen(seated()).image, 580);
    expect(Array.from(shown.data.subarray((900 * MINI_CANVAS + 200) * 4, (900 * MINI_CANVAS + 200) * 4 + 3))).toEqual([150, 158, 175]);
  });

  it('gives the model a board for an edge and an empty canvas for a hang', () => {
    expect(guideFor('sit').data[(GUIDE_EDGE * MINI_CANVAS + 500) * 4 + 1]).toBe(255);
    expect(guideFor('hang').data.every(value => value === 0)).toBe(true);
    expect(drawPrompt(MINI_SEED_SPECS.find(spec => spec.contact === 'hang')!)).not.toContain('green rectangle');
  });
});

describe('the walk sheet', () => {
  it('finds four figures by the gaps between them, closing the narrowest gap when a hand leaves a sliver', () => {
    const sheet = blankImage(1000, 200);
    for (const [from, to] of [[20, 180], [260, 420], [430, 440], [500, 660], [760, 920]] as const) paint(sheet, [from, 20, to, 180], [120, 170, 240, 255]);
    const spans = figureSpans(sheet, 4)!;
    expect(spans).toHaveLength(4);
    expect(spans[1]).toEqual([256, 444]);
    const three = blankImage(1000, 200);
    for (const [from, to] of [[20, 180], [260, 420], [500, 660]] as const) paint(three, [from, 20, to, 180], [120, 170, 240, 255]);
    expect(figureSpans(three, 4)).toBeNull();
  });

  it('refuses a sitting picture whose legs went out with the board', () => {
    const image = blankImage(MINI_CANVAS, MINI_CANVAS);
    paint(image, [118, 580, 906, MINI_CANVAS - 1], [0, 250, 10, 255]);
    paint(image, [400, 150, 620, 578], [120, 170, 240, 255]);
    expect(shapeBase(image, 'sit')).toEqual({ reason: 'legs_hidden' });
  });
});

describe('the seed library', () => {
  it('has each of the 22 faces standing, sitting and lying, and the moving pictures, with unique ids', () => {
    const ids = MINI_SEED_SPECS.map(spec => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const contact of ['stand', 'sit', 'lie'] as const) expect(MINI_SEED_SPECS.filter(spec => spec.contact === contact && spec.activity === 'rest' && spec.id.startsWith(`seed_${contact}_`)).length).toBe(22);
    for (const activity of ['walk', 'jump', 'fall', 'carried', 'sleep'] as const) expect(MINI_SEED_SPECS.some(spec => spec.activity === activity)).toBe(true);
  });
});

/** Models that draw `seated()` (a mouth edit paints a mouth), read a fixed verdict and embed by a word list. */
function fakeModels(verdict: Record<string, unknown> = { same_character: true, chibi: true, one_character: true, clean: true, anatomy_ok: true, pose_matches: true, variants_ok: true }) {
  const words = ['wave', 'sad', 'sleep', 'laugh', 'angry'];
  const embed = (text: string) => words.map(word => (text.includes(word) ? 1 : 0.01));
  const calls = { draw: 0, read: 0, embed: 0 };
  const models: MiniModels = {
    async draw(request) {
      calls.draw++;
      if (request.images.length === 1) {
        const base = decodePng(request.images[0]!);
        paint(base, [495, 320, 525, 335], request.prompt.includes('mouth') ? [200, 40, 60, 255] : [20, 20, 60, 255]);
        return { value: encodePng(base), seconds: 1, costUsd: 0.02 };
      }
      return { value: encodePng(seated()), seconds: 2, costUsd: 0.08 };
    },
    async read(request) {
      calls.read++;
      if (request.images?.length) return { value: verdict, seconds: 0.5, costUsd: 0.001 };
      return { value: { contact: 'sit', description: 'waving happily while sitting', label: '手をふる' }, seconds: 0.4, costUsd: 0.0005 };
    },
    async embed(texts) { calls.embed++; return { value: texts.map(embed), seconds: 0.1, costUsd: 0 }; },
  };
  return { models, calls };
}

function libraryWithReferences(): MiniPoseLibrary {
  const root = folder();
  const library = new MiniPoseLibrary(root);
  writeFileSync(join(root, 'reference', 'sheet.png'), encodePng(blankImage(64, 32)));
  writeFileSync(join(root, 'reference', 'original.png'), encodePng(blankImage(32, 64)));
  return library;
}

describe('drawing a pose', () => {
  it('keeps the base and the three face variants, with the anchor, seconds and cost', async () => {
    const library = libraryWithReferences(), { models, calls } = fakeModels();
    const generator = new MiniPoseGenerator({ library, models, now: () => '2026-10-28T01:00:00.000Z' });
    const outcome = await generator.draw({ contact: 'sit', expression: 'joyful', description: 'waving', label: '手をふる', activity: 'rest', variants: 'face' },
      { source: 'seed', requestKey: null, id: 'seed_sit_joyful' });
    expect(outcome.entry?.variants).toEqual(['base', 'talk', 'blink', 'talkBlink']);
    expect(outcome.entry?.anchor.y).toBe(580);
    expect(calls.draw).toBe(3);
    expect(outcome.costUsd).toBeCloseTo(0.08 + 0.04 + 0.001, 5);
    expect(library.get('seed_sit_joyful')).not.toBeNull();
  });

  it('draws again when the inspector refuses, and keeps nothing after the last refusal', async () => {
    const library = libraryWithReferences(), { models, calls } = fakeModels({ same_character: false, problems: 'different hair' });
    const generator = new MiniPoseGenerator({ library, models });
    const outcome = await generator.draw({ contact: 'sit', expression: 'sad', description: 'sad', label: 'かなしい', activity: 'rest', variants: 'face' },
      { source: 'generated', requestKey: 'r1' });
    expect(outcome.entry).toBeNull();
    expect(outcome.attempts).toBe(2);
    expect(outcome.reason).toContain('same_character');
    expect(calls.draw).toBe(6);
    expect(library.active()).toHaveLength(0);
  });
});

function entry(id: string, description: string, expression: string, contact: MiniPoseEntry['contact'] = 'sit'): MiniPoseEntry {
  return { id, contact, expression, description, label: id, activity: 'rest', variants: ['base'], anchor: { x: 512, y: 600 },
    bounds: { left: 400, top: 100, right: 620, bottom: 800 }, size: { width: 1024, height: 1024 }, source: 'seed', requestKey: null,
    createdAt: '2026-10-28T00:00:00.000Z', uses: 0, lastUsedAt: null, retired: false };
}

function jevAnswering(choice: string, traces: JevChoiceTrace[] = [], missing = 0.1) {
  const fetcher = (async () => new Response(JSON.stringify({ answers: { picture: { choice }, missing_gesture: { noul: missing } } }))) as unknown as typeof fetch;
  return new JevChooser(new JevChoiceClient({ apiKey: 'test-key', fetcher }), { usdPerCall: null, cacheMilliseconds: 0, trace: (_s, trace) => { traces.push(trace); } });
}

describe('choosing a picture for a reply', () => {
  async function setUp(choice: string | null, missing = 0.1) {
    const library = libraryWithReferences(), { models } = fakeModels();
    for (const [id, text, face] of [['a', 'waving happily', 'joyful'], ['b', 'sad and teary', 'sad'], ['c', 'laughing hard', 'laughing']] as const) {
      library.add(entry(id, text, face), new Map([['base', encodePng(blankImage(4, 4))]]), (await models.embed([`${face} | sit | ${text}`])).value[0]!);
    }
    const traces: JevChoiceTrace[] = [];
    const generator = new MiniPoseGenerator({ library, models });
    const chooser = new MiniPoseChooser({ library, models, generator, chooser: choice === null ? null : jevAnswering(choice, traces, missing) });
    return { library, chooser, traces };
  }
  const request = { text: 'I am so sad today', expression: 'sad', contacts: ['sit' as const], requestKey: 'k1' };

  it('shows the picture Jev chose, closest first in the menu, and records a hit', async () => {
    const { library, chooser, traces } = await setUp('p0');
    const result = await chooser.choose('owner', request, true);
    expect(result).toMatchObject({ poseId: 'b', source: 'library', drawing: false });
    expect(traces[0]?.decision).toBe('mini_pose');
    expect(miniStats(library).choices).toMatchObject({ total: 1, library: 1, hitRate: 1 });
  });

  it('shows Jev\'s picture and draws a new one when Jev says the reply shows a gesture none has, for the owner only', async () => {
    const owner = await setUp('p1', 0.8);
    expect(await owner.chooser.choose('owner', request, true)).toMatchObject({ poseId: 'a', source: 'nearest', drawing: true });
    expect(miniStats(owner.library).choices).toMatchObject({ total: 1, library: 0, drawingsAsked: 1 });
    const guest = await setUp('p1', 0.8);
    expect(await guest.chooser.choose('guest', request, false)).toMatchObject({ source: 'nearest', drawing: false });
  });

  it('without Jev, the closest stands in and nothing is drawn', async () => {
    const { chooser, library } = await setUp(null);
    expect(await chooser.choose('owner', request, true)).toMatchObject({ poseId: 'b', source: 'nearest', drawing: false });
    expect(miniStats(library).choices.hitRate).toBe(0);
  });

  it('asks for the best of the candidates, and separately whether a gesture is missing', () => {
    const questions = miniPoseQuestions([entry('a', 'waving', 'joyful'), entry('b', 'sad', 'sad')]);
    expect(Object.keys(questions.picture!.criteria)).toEqual(['p0', 'p1']);
    expect(questions.missing_gesture!.type).toBe('noul');
  });
});

describe('the choose request', () => {
  it('accepts a well-formed request and drops unknown contacts', () => {
    expect(parsedChooseRequest({ text: 'hi', expression: 'joyful', contacts: ['sit', 'fly'], requestKey: 'turn-1', activity: 'walk' }))
      .toEqual({ text: 'hi', expression: 'joyful', contacts: ['sit'], requestKey: 'turn-1', feeling: null, activity: 'walk' });
    expect(parsedChooseRequest({ text: 'hi', expression: 'joyful', contacts: ['fly'], requestKey: 'turn-1' })).toBeNull();
    expect(parsedChooseRequest({ text: 'hi', expression: '<script>', contacts: ['sit'], requestKey: 'turn-1' })).toBeNull();
  });
});

describe('the records', () => {
  it('reads the hit rate and the drawing times per day from the events', () => {
    const library = libraryWithReferences();
    library.record({ kind: 'choose', at: '2026-10-28T01:00:00Z', requestKey: 'a', source: 'library', poseId: 'x', jev: 'jev', candidates: 8, ms: 400, expression: 'joyful', contacts: ['sit'], drawing: false });
    library.record({ kind: 'choose', at: '2026-10-28T02:00:00Z', requestKey: 'b', source: 'nearest', poseId: 'x', jev: 'jev', candidates: 8, ms: 600, expression: 'sad', contacts: ['sit'], drawing: true });
    library.record({ kind: 'draw', at: '2026-10-28T02:01:00Z', requestKey: 'b', poseId: 'y', ok: true, attempts: 1, reason: null, seconds: { base: 25, total: 52 }, costUsd: 0.12 });
    const stats = miniStats(library);
    expect(stats.choices.hitRate).toBe(0.5);
    expect(stats.drawings).toMatchObject({ ok: 1, medianSeconds: 52, costUsd: 0.12 });
    expect(stats.days).toEqual([{ day: '2026-10-28', choices: 2, library: 1, drawings: 1, costUsd: 0.12, hitRate: 0.5 }]);
    expect(readFileSync(join(library.root, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
