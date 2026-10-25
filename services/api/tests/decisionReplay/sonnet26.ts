import { existsSync, readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
import { loadScenes, type SceneFile } from './score.js';
import type { View } from './views5.js';
import type { Row2 } from './run2.js';

/**
 * 10/26 mc-sonnet-guards の比べの共通部品。版は 4 つ:
 *   O = 前回の Opus 5.5（rel44 の入力。参考）、S = 前回の Sonnet 5.5（基準。rel44 の頭・守り）、
 *   C = 直しを入れた Sonnet 5.5（この branch の頭・守り・入力）、B2 = 基準の頭で、台の側だけ「点検の節の禁止の決まり」を足した Sonnet（s37 s39 s41 s46 s47 の切り分け）。
 * 結果の行は run6.ts が data/g26-*.jsonl に書く（S と O は前回の sn-S・sn-O）。
 */
export const G26_FILES = ['sn-O.jsonl', 'sn-S.jsonl', 'g26-Sx.jsonl', 'g26-Sx2.jsonl', 'g26-C-a.jsonl', 'g26-C-b.jsonl', 'g26-C-c.jsonl', 'g26-C-d.jsonl', 'g26-B2.jsonl', 'g26-A1.jsonl', 'g26-A2.jsonl'];
export const VIEWS26: View[] = [
  { id: 'O', variant: 'O', transform: 'candidate', label: 'O: 前回の Opus 5.5（参考）' },
  { id: 'S', variant: 'S', transform: 'candidate', label: 'S: 前回の Sonnet 5.5（基準 = rel44 の頭・守り）' },
  { id: 'B2', variant: 'B2', transform: 'candidate', label: 'B2: 基準 + 台の側で点検の節の禁止の決まりを足した Sonnet' },
  { id: 'A1', variant: 'A1', transform: 'candidate', label: 'A1: C から知識の文の直しだけ戻した（切り分け）' },
  { id: 'A2', variant: 'A2', transform: 'candidate', label: 'A2: C から禁止の決まりの文の直しだけ戻した（切り分け）' },
  { id: 'C', variant: 'C', transform: 'candidate', label: 'C: 直しを入れた Sonnet 5.5（mc-sonnet-guards）' },
];
export function readRows26(files: readonly string[] = G26_FILES): Row2[] {
  return files.flatMap(name => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : []);
}
const sceneDir = (name: string) => new URL(`./${name}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** 60 場面（scenes/）・scenes-b・scenes-c のうち、C の行がある場面。 */
export function scenes26(rows: readonly { scene: string; variant: string }[]): SceneFile[] {
  const have = new Set(rows.filter(row => row.variant === 'C').map(row => row.scene));
  return [...loadScenes(sceneDir('scenes')), ...loadScenes(sceneDir('scenes-b')), ...loadScenes(sceneDir('scenes-c'))].filter(scene => have.has(scene.id));
}
/** 前回の 23 場面（追加の場面を除く）。 */
export const EXTRA = ['s16', 's18', 's23', 's35', 's67'];
export const short = (id: string) => id.split('-')[0]!;
