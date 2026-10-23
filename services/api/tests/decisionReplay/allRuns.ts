import type { Run } from './load.js';
import { loadRuns } from './load.js';

/** 実走32〜34（export1 + journal）と実走27〜31（export2）の全部。場面のファイルの run（r27〜r34）がこれを引く。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export function loadAllRuns(): Map<string, Run> {
  return new Map([...loadRuns(p('export1.txt'), p('journal.txt')), ...loadRuns(p('export2.txt')), ...loadRuns(p('export3.txt'), p('journal3.txt'))]);
}
export const dataFile = p;
