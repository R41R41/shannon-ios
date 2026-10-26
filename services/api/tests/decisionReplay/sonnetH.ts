import { existsSync, readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
import { loadScenes, type SceneFile } from './score.js';
import type { View } from './views5.js';
import type { Row2 } from './run2.js';

/**
 * 10/27 mc-run39-fixes の比べの共通部品。版は 2 つ: P = 基準（今の本番 628a5a3、rel55b。入力は前回の列の版 566abe5 と同じなので、dragon26 の 30 場面は前回の Q の答えを使う）、
 * H = 候補（shannon-ios `codex/shannon/mc-run39-fixes` 先頭 0b76174: 実走 39 の直しと新しい手 7 つ）。
 * 場面: scenes-d（dragon26 の 30）+ scenes-e（実走 39 の 10: 新しい手が効くはずの場面）。結果の行は run6.ts が data/th-<版>.jsonl に書く。
 */
export const VIEWS_H: View[] = [
  { id: 'P', variant: 'P', transform: 'candidate', label: 'P: 基準（628a5a3、rel55b）の Sonnet' },
  { id: 'H', variant: 'H', transform: 'candidate', label: 'H: 実走 39 の直しと新しい手（0b76174）の Sonnet' },
];
/** 前回の列の版（Q）の行は、入力が基準と同じなので P の行として読む（dragon26 の 30 場面）。 */
export function readRowsH(): Row2[] {
  const read = (name: string, rename?: [string, string]) => existsSync(dataFile(name))
    ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2).map(row => rename && row.variant === rename[0] ? { ...row, variant: rename[1] } : row) : [];
  return [...read('tq-Q.jsonl', ['Q', 'P']), ...read('th-P.jsonl'), ...read('th-H.jsonl'), ...read('th-H-e.jsonl'), ...read('th-P-e.jsonl')];
}
const sceneDir = (name: string) => new URL(`./${name}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export function scenesH(rows: readonly { scene: string; variant: string }[]): SceneFile[] {
  const have = new Set(rows.filter(row => row.variant === 'H').map(row => row.scene));
  return [...loadScenes(sceneDir('scenes-d')), ...loadScenes(sceneDir('scenes-e'))].filter(scene => have.has(scene.id));
}
export const short = (id: string) => id.split('-')[0]!;
export const themeOf = (id: string) => /-(move|obsidian|table|descend|pillar)\.json$|-(move|obsidian|table|descend|pillar)$/u.exec(id)?.[1] ?? /-(move|obsidian|table|descend|pillar)$/u.exec(id)?.[1] ?? null;
export const isNew = (id: string) => /^s2\d\d-r40-/u.test(id);
