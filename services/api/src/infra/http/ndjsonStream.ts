import type { ServerResponse } from 'node:http';

export function startStream(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
}

export async function writeEvent(response: ServerResponse, event: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  if (response.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('error', failed);
      response.off('close', closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(new Error('VOICE_STREAM_CLOSED')); };
    response.once('drain', drained);
    response.once('error', failed);
    response.once('close', closed);
  });
}
