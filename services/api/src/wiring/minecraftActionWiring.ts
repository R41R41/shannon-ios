import { actionResource, leaseOf, type ActionThreads, type ActionView, type MinecraftExecutionPort } from '../contracts/actionThreadContract.js';
/** One physical body, one canonical request. A lease loss returns its existing cancel signal. */
export function minecraftActionPort(actions: ActionThreads): MinecraftExecutionPort {
  const find = async (scopeKey: string, id: string) => (await actions.list(scopeKey)).find(view => view.kind === 'minecraft' && view.sourceId === id);
  return {
    async admit(scopeKey, id, deviceId) {
      const queued = await actions.enqueue({ scopeKey, kind: 'minecraft', origin: 'owner_request', sourceId: id,
        ownerInformed: true, resources: [actionResource(deviceId, 'minecraft-body')] });
      const view = queued.state === 'queued' ? await actions.claim(queued.id) : queued;
      return !!view?.holder && ['running', 'waiting'].includes(view.state) && await actions.dispatch(leaseOf(view));
    },
    async heartbeat(scopeKey, id) {
      const view = await find(scopeKey, id);
      return !!view?.holder && !!await actions.renew(leaseOf(view));
    },
    async acknowledge(scopeKey, id, state) {
      const view = await find(scopeKey, id);
      if (!view) return;
      if (['completed', 'failed', 'cancelled'].includes(view.state)) return;
      if (view.state === 'queued') {
        await actions.stop(scopeKey,view.id,`body-terminal:${id}`);
        return;
      }
      if (view.state === 'unknown') {
        // The body reports a known terminal outcome for the original unique request id; it was never re-issued.
        if (!view.lastHolder || !await actions.reconcile({ id: view.id, generation: view.generation-1, holder: view.lastHolder }, state, 'body_result')) throw new Error('BODY_ACK_WAIT');
      } else if (view.holder) {
        const lease = leaseOf(view);
        if (!await actions.finish(lease, state, 'body_result') && !await actions.reconcile(lease, state, 'body_result')) throw new Error('BODY_ACK_WAIT');
      } else throw new Error('BODY_ACK_WAIT');
    },
  };
}
