import { readFileSync } from 'node:fs';
import { skillImportEndpoint } from '../src/infra/http/skillImportCommand.js';

/** Owner's paired-device HTTP client. It never opens SQLite, enables skills, or imports automatically. */
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
const mode = args[0];
if (mode !== 'dry-run' && mode !== 'apply') throw new Error('Use dry-run or apply with --url, --token-file, --pack and --revision; apply also needs --plan-hash and --approval-reference');
const endpoint = value('--url');
const tokenFile = value('--token-file');
const packId = value('--pack');
const revision = value('--revision');
const planHash = value('--plan-hash');
const approvalReference = value('--approval-reference');
if (!endpoint || !tokenFile || !packId || !revision || (mode === 'apply' && (!planHash || !approvalReference))) throw new Error('Missing required skill import argument');
// The server's base path is kept (`https://sh4nnon.com/companion`); it used to be replaced, and the import answered 404.
const url = skillImportEndpoint(endpoint, mode);
const token = readFileSync(tokenFile, 'utf8').trim();
if (!token || /\s/u.test(token)) throw new Error('Invalid paired-device token file');
const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ packId, revision, ...(mode === 'apply' ? { planHash, approvalReference } : {}) }), signal: AbortSignal.timeout(20_000) });
const result: unknown = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
