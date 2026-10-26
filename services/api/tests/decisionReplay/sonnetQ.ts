import { existsSync, readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
import { loadScenes, type SceneFile } from './score.js';
import type { View } from './views5.js';
import type { Row2 } from './run2.js';

/**
 * 10/26 mc-task-queue の比べの共通部品。版は 2 つ: B = 基準（今の本番の頭 fb011ad、rel54）、Q = 候補（shannon-ios `codex/shannon/mc-task-queue` 566abe5）。
 * 場面は 10/26 の動作確認の実走（台の r39）の 30（scenes-d/）。結果の行は run6.ts が data/tq-<版>.jsonl に書く。
 */
export const TQ_FILES = ['tq-B.jsonl', 'tq-Q.jsonl', 'tq-Q2.jsonl', 'tq-B2.jsonl'];
export const VIEWS_Q: View[] = [
  { id: 'B', variant: 'B', transform: 'candidate', label: 'B: 基準（fb011ad、rel54）の Sonnet' },
  { id: 'Q', variant: 'Q', transform: 'candidate', label: 'Q: 列の版（566abe5）の Sonnet' },
];
export function readRowsQ(files: readonly string[] = TQ_FILES): Row2[] {
  return files.flatMap(name => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : []);
}
const sceneDir = (name: string) => new URL(`./${name}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** scenes-d/ の 30 場面のうち、Q の行がある場面。 */
export function scenesQ(rows: readonly { scene: string; variant: string }[]): SceneFile[] {
  const have = new Set(rows.filter(row => row.variant === 'Q').map(row => row.scene));
  return loadScenes(sceneDir('scenes-d')).filter(scene => have.has(scene.id));
}
export const short = (id: string) => id.split('-')[0]!;
/** かまどなどの待ちの場面（記録の答えが wait を含む）。 */
export const WAIT_SEQ = [2267, 2280, 2292, 2323];
