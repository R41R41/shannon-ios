import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decisionDocument, listRuns, readRun, selectRequests, type Selector } from '../src/infra/decisionRecords/decisionRecordRead.js';
import { renderDecisions } from '../src/infra/decisionRecords/decisionRecordMarkdown.js';
import { DECISION_RECORD_LIMITS, pruneRuns, runName } from '../src/infra/decisionRecords/decisionRecordStore.js';
import { decisionRecordsRoot } from '../src/infra/decisionRecords/decisionRecorder.js';

/**
 * 判断の記録（decision records）を取り出す台本。記録は API の SQLite の隣の decision-records/ にある（docs/decision-records-2026-10.md）。
 *
 *   pnpm --filter @shannon/api decision-record list    [--dir <decision-records>]
 *   pnpm --filter @shannon/api decision-record show    --task <task id> (--no N | --id d0015 | --step N | --at <時刻> | --item q15) [--format md|json] [--out <file>]
 *                                                     [--last <直近 N 件のメッセージだけ>] [--signatures] [--dir <decision-records>]
 *   pnpm --filter @shannon/api decision-record prune   [--dir <decision-records>] [--max-runs N] [--max-bytes N]
 *
 * --dir を省くと SHANNON_DATABASE_PATH の隣の decision-records を使う。show は 1 つの判断（--step は 1 つの step の全 round）の入力の全部・出力・
 * 頭が体へ送った形・版を 1 つのファイルにする（--out を省くと標準出力）。メッセージ中の thinking の署名は長さだけにする（--signatures で残す）。
 */
const args = process.argv.slice(2);
const command = args[0];
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(`--${name}`);
const number = (name: string): number | undefined => {
  const value = option(name);
  return value === undefined ? undefined : Number(value);
};
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const root = option('dir') ? resolve(option('dir')!) : decisionRecordsRoot(process.env.SHANNON_DATABASE_PATH);
if (!root) fail('記録の場所が分からない: --dir <decision-records> か SHANNON_DATABASE_PATH を指定してください');

function show(): void {
  const task = option('task');
  if (!task) fail('--task <task id> が要ります（list で名前を見られます）');
  const selector: Selector = { ...(option('id') ? { id: option('id')! } : {}), ...(number('no') !== undefined ? { no: number('no')! } : {}),
    ...(number('step') !== undefined ? { step: number('step')! } : {}), ...(option('at') ? { at: option('at')! } : {}), ...(option('item') ? { item: option('item')! } : {}),
    ...(option('kind') ? { kind: option('kind')! } : {}) };
  if (!Object.keys(selector).filter(key => key !== 'kind').length) fail('どの判断かを --no / --id / --step / --at / --item のどれかで指定してください');
  const run = readRun(join(root!, runName(task)));
  const found = selectRequests(run, selector);
  if (!found.length) fail(`該当する判断が無い（${run.events.length} 行を読んだ）`);
  const documents = found.map(request => decisionDocument(run, request, { keepSignatures: flag('signatures'), ...(number('last') !== undefined ? { lastMessages: number('last')! } : {}) }));
  const text = option('format') === 'json' ? `${JSON.stringify(documents.length === 1 ? documents[0] : documents, null, 2)}\n` : `${renderDecisions(documents)}\n`;
  const out = option('out');
  if (!out) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out} (${found.map(request => request.id).join(', ')}; ${text.length} chars)`);
}

async function main(): Promise<void> {
  if (command === 'list') {
    for (const run of listRuns(root!)) {
      console.log(`${run.name}\t${run.startedAt}\t${run.lastAt}\tdecisions=${run.decisions} summaries=${run.summaries} plans=${run.plans} sent=${run.sent}\t${(run.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
  } else if (command === 'show') show();
  else if (command === 'prune') {
    const removed = await pruneRuns(root!, { ...DECISION_RECORD_LIMITS, ...(number('max-runs') !== undefined ? { maxRuns: number('max-runs')! } : {}),
      ...(number('max-bytes') !== undefined ? { maxTotalBytes: number('max-bytes')! } : {}) });
    console.log(removed.length ? `removed: ${removed.join(', ')}` : 'nothing to remove');
  } else fail('使い方: decision-record list | show | prune（先頭のコメントを見てください）');
}
await main();
