import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DecisionRecorder, RequestNote } from '../src/infra/decisionRecords/decisionRecorder.js';
import { decisionRecorder, installDecisionRecorder } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { scrubSecrets } from '../src/infra/decisionRecords/decisionRecordStore.js';

const sensitiveKey = /^(?:headers?|authorization|api[_-]?key|cookie|secret|access[_-]?token|refresh[_-]?token)$/iu;
function containsCredentialField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => sensitiveKey.test(key) || containsCredentialField(entry));
}

/** Opt-in, lab-only first requests. Reuses the final-body recorder hook, without its headers, responses, raw live, owner chat or general event files. */
export function installRigFirstPayload(options: { enabled: string | undefined; keep: boolean; modelMode: string; directory: string; obsMode: string;
  minecraftTask(id: string): boolean; log(code: string): void; root?: string; now?: () => number }) {
  if (!options.enabled || options.enabled === 'off') return null;
  // 'all' (opening lane, 11/9): every decision/plan final body, numbered, for the scene replay (same refusals; lab rig only).
  const every = options.enabled === 'all';
  if ((options.enabled !== 'on' && !every) || !options.keep || options.modelMode !== 'real') throw new Error('RIG_FIRST_PAYLOAD_REQUIRES_KEPT_REAL_RIG');
  const directory = fs.realpathSync(options.directory);
  const root = fs.realpathSync(options.root ?? path.join(os.homedir(), '.cache', 'minebot-lab', 'rig'));
  if (fs.lstatSync(options.directory).isSymbolicLink() || path.dirname(directory) !== root || !/^\d{1,32}$/u.test(path.basename(directory)))
    throw new Error('RIG_FIRST_PAYLOAD_DIRECTORY_REFUSED');
  if (decisionRecorder()) throw new Error('RIG_FIRST_PAYLOAD_RECORDER_ALREADY_INSTALLED');
  const now = options.now ?? Date.now, began = now(), seen = new Set<string>();
  const log = (code: string) => { try { options.log(code); } catch { /* capture never changes the decision */ } };
  let firstObservationMs: number | null = null, firstWorldScanMs: number | null = null, firstScanAt: string | null = null, closed = false;
  const state = () => ({ obsMode: options.obsMode, firstObservationMs, firstWorldScanArrived: firstWorldScanMs !== null, firstWorldScanMs, firstScanAt });
  let numbered = 0;
  const save = (name: string, value: unknown) => {
    try {
      const text = every ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(text) > (every ? 4 : 2) * 1024 * 1024 || scrubSecrets(text) !== text) { log('RIG_FIRST_PAYLOAD_REFUSED_MATERIAL'); return; }
      fs.writeFileSync(path.join(directory, name), text, { flag: 'wx', mode: 0o600 });
    } catch { log('RIG_FIRST_PAYLOAD_WRITE_FAILED'); }
  };
  // This deliberately implements only the existing hook port. All other recorder entries are no-ops; no full DecisionRecorder is installed.
  const sink = {
    request(note: RequestNote): null {
      try {
        if (closed || !note.scope.record || !options.minecraftTask(note.scope.taskId)) return null;
        if (!every && (!['decision', 'plan'].includes(note.kind) || seen.has(note.kind))) return null;
        seen.add(note.kind);
        if (containsCredentialField(note.body)) { log('RIG_FIRST_PAYLOAD_REFUSED_MATERIAL'); return null; }
        const text = JSON.stringify(note.body);
        if (every) fs.mkdirSync(path.join(directory, 'payloads'), { recursive: true, mode: 0o700 });
        const name = every ? path.join('payloads', `${String(++numbered).padStart(4, '0')}-${String(note.kind).replace(/[^a-z0-9_-]/giu, '_')}.json`) : `first-provider-${note.kind}.json`;
        save(name, { kind: note.kind, taskId: note.scope.taskId, capturedMs: now() - began, ...state(),
          bodySha256: createHash('sha256').update(text).digest('hex'), body: note.body });
      } catch { log('RIG_FIRST_PAYLOAD_WRITE_FAILED'); }
      return null; // Preserve the original provider promise; do not collect responses or call options.
    },
    response() {}, append() {}, row() {}, headBooted() {}, noteHistory() {}, tail: () => [], headHold: () => null,
  };
  installDecisionRecorder(sink as unknown as DecisionRecorder);
  return {
    observe(poll: unknown) {
      try {
        if (closed || !poll || typeof poll !== 'object') return;
        const observation = (poll as { observation?: any }).observation;
        if (!observation || observation.connected === false) return;
        firstObservationMs ??= now() - began;
        const scan = observation.state?.world?.scan;
        if (scan && typeof scan.at === 'string' && typeof scan.text === 'string' && firstWorldScanMs === null) {
          firstWorldScanMs = now() - began; firstScanAt = scan.at;
        }
      } catch { log('RIG_FIRST_PAYLOAD_OBSERVATION_FAILED'); }
    },
    close() {
      if (closed) return;
      closed = true;
      if (decisionRecorder() === (sink as unknown)) installDecisionRecorder(null);
      save('first-provider-observation.json', state());
    },
  };
}
