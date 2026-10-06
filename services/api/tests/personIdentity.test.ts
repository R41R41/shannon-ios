import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { SQLitePersonIdentityStore } from '../src/mind/memory/store/personIdentity.js';

describe('person identity registry', () => {
  it('requires an explicit confirmation and resets confirmation after a Discord ID correction', async () => {
    const store = new SQLitePersonIdentityStore(':memory:');
    const clock = advancingClock();
    const api = createLocalApiKernel(clock, { personIdentities: store });

    const created = await api.dispatch({
      method: 'POST',
      path: '/v1/people/candidates',
      body: { scopeKey: 'owner-a', displayName: '友人A', platform: 'discord', externalUserId: '123456789' },
    });
    expect(created.status).toBe(201);
    const candidate = personBody(created.body);
    expect(candidate).toMatchObject({ displayName: '友人A', status: 'candidate', revision: 1 });
    expect(candidate.identities[0]).toMatchObject({ status: 'candidate', revision: 1 });

    const confirmed = await identityAction(api, 'confirm', candidate.id, 1);
    expect(confirmed.status).toBe(200);
    expect(personBody(confirmed.body)).toMatchObject({ status: 'active', revision: 2 });
    expect(personBody(confirmed.body).identities[0]).toMatchObject({ status: 'confirmed', revision: 2 });

    const stale = await identityAction(api, 'revoke', candidate.id, 1);
    expect(stale).toEqual({ status: 409, body: { error: 'PERSON_IDENTITY_STALE' } });

    const corrected = await api.dispatch({
      method: 'POST',
      path: '/v1/people/identities/correct',
      body: {
        scopeKey: 'owner-a', personId: candidate.id, platform: 'discord', expectedRevision: 2,
        displayName: '友人A（訂正）', externalUserId: '987654321',
      },
    });
    expect(corrected.status).toBe(200);
    expect(personBody(corrected.body)).toMatchObject({ displayName: '友人A（訂正）', status: 'candidate', revision: 3 });
    expect(personBody(corrected.body).identities[0]).toMatchObject({
      externalUserId: '987654321', status: 'candidate', revision: 3, confirmedAt: null,
    });

    store.close();
  });

  it('keeps confirmation for a name-only correction, supports revocation, and hard-deletes personal data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-person-identity-'));
    const path = join(directory, 'people.sqlite');
    const store = new SQLitePersonIdentityStore(path);
    const api = createLocalApiKernel(advancingClock(), { personIdentities: store });
    const created = await api.dispatch({
      method: 'POST', path: '/v1/people/candidates',
      body: { scopeKey: 'owner-a', displayName: '旧名', platform: 'discord', externalUserId: '111222333' },
    });
    const id = personBody(created.body).id;

    await identityAction(api, 'confirm', id, 1);
    const renamed = await api.dispatch({
      method: 'POST', path: '/v1/people/identities/correct',
      body: { scopeKey: 'owner-a', personId: id, platform: 'discord', expectedRevision: 2, displayName: '新名' },
    });
    expect(personBody(renamed.body)).toMatchObject({ displayName: '新名', status: 'active', revision: 3 });
    expect(personBody(renamed.body).identities[0]).toMatchObject({ status: 'confirmed', revision: 3 });

    const revoked = await identityAction(api, 'revoke', id, 3);
    expect(personBody(revoked.body)).toMatchObject({ status: 'revoked', revision: 4 });
    expect(personBody(revoked.body).identities[0]).toMatchObject({ status: 'revoked', revision: 4 });

    const deleted = await api.dispatch({
      method: 'POST', path: '/v1/people/delete',
      body: { scopeKey: 'owner-a', personId: id, expectedRevision: 4 },
    });
    expect(deleted).toEqual({ status: 200, body: { deleted: true, personId: id } });
    expect(await listPeople(api, 'owner-a')).toEqual([]);
    const audit = await api.dispatch({
      method: 'GET', path: '/v1/people/audit', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain('111222333');
    expect(JSON.stringify(audit.body)).not.toContain('新名');
    expect((audit.body as { events: unknown[] }).events).toHaveLength(5);
    store.close();

    const reopened = new SQLitePersonIdentityStore(path);
    expect(reopened.list('owner-a')).toEqual([]);
    expect(reopened.audit('owner-a').at(0)?.action).toBe('person-deleted');
    reopened.close();
  });

  it('rejects duplicate or malformed identities while isolating owner scopes', async () => {
    const api = createLocalApiKernel(advancingClock(), {
      personIdentities: new SQLitePersonIdentityStore(':memory:'),
    });
    const candidate = (scopeKey: string, externalUserId: string, displayName = '友人') => api.dispatch({
      method: 'POST' as const,
      path: '/v1/people/candidates',
      body: { scopeKey, displayName, platform: 'discord', externalUserId },
    });
    expect((await candidate('owner-a', '444555666')).status).toBe(201);
    expect(await candidate('owner-a', '444555666')).toEqual({
      status: 409, body: { error: 'PERSON_IDENTITY_CONFLICT' },
    });
    expect((await candidate('owner-b', '444555666')).status).toBe(201);
    expect((await candidate('owner-a', 'not-a-discord-id')).status).toBe(400);
    expect((await candidate('owner-a', '777888999', '   ')).status).toBe(400);
    expect(await listPeople(api, 'owner-a')).toHaveLength(1);
    expect(await listPeople(api, 'owner-b')).toHaveLength(1);
  });
});

function advancingClock(): () => string {
  let milliseconds = Date.parse('2026-09-18T00:00:00.000Z');
  return () => new Date(milliseconds++).toISOString();
}

async function identityAction(
  api: ReturnType<typeof createLocalApiKernel>,
  action: 'confirm' | 'revoke',
  personId: string,
  expectedRevision: number,
) {
  return api.dispatch({
    method: 'POST',
    path: `/v1/people/identities/${action}`,
    body: { scopeKey: 'owner-a', personId, platform: 'discord', expectedRevision },
  });
}

async function listPeople(api: ReturnType<typeof createLocalApiKernel>, scopeKey: string): Promise<unknown[]> {
  const response = await api.dispatch({
    method: 'GET', path: '/v1/people', query: new URLSearchParams({ scopeKey }),
  });
  expect(response.status).toBe(200);
  return (response.body as { people: unknown[] }).people;
}

function personBody(value: unknown): {
  id: string;
  displayName: string;
  status: string;
  revision: number;
  identities: Array<Record<string, unknown>>;
} {
  return value as {
    id: string;
    displayName: string;
    status: string;
    revision: number;
    identities: Array<Record<string, unknown>>;
  };
}
