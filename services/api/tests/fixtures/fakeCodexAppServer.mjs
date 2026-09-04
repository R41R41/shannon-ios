import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadNumber = 0;
let turnNumber = 0;

lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }
  if (message.method === 'thread/start') {
    threadNumber += 1;
    send({ id: message.id, result: { thread: { id: `thread-${threadNumber}`, status: { type: 'idle' }, turns: [] } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: 'idle' }, turns: [] } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: {
      threadId: message.params.threadId,
      turn: { id: message.params.turnId, status: 'interrupted', items: [] },
    } });
    return;
  }
  if (message.id !== undefined && message.result) {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: message.id } });
  }
});
