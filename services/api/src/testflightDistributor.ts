import { createPrivateKey, sign } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuredDatabasePath } from './sqliteStore.js';
import { SQLiteTestFlightDeliveryStore } from './integrations/testflight/store/testflightDeliveryStore.js';

const appStoreConnectOrigin = 'https://api.appstoreconnect.apple.com';

export interface TestFlightDistributionConfig {
  readonly keyId: string;
  readonly privateKeyPath: string;
  readonly appId: string;
  readonly betaGroupId: string;
  readonly statePath?: string;
}

interface BuildResource {
  readonly type: 'builds';
  readonly id: string;
  readonly attributes: {
    readonly version?: string;
    readonly uploadedDate?: string;
    readonly processingState?: string;
    readonly expired?: boolean;
    readonly buildAudienceType?: string;
  };
}

interface ResourceLinkage {
  readonly type: string;
  readonly id: string;
}

interface JsonApiList<T> {
  readonly data: readonly T[];
}

interface DistributionState {
  readonly lastDistributedBuildId: string;
  readonly version: string;
  readonly distributedAt: string;
}

export type TestFlightDistributionResult =
  | { readonly status: 'distributed'; readonly buildId: string; readonly version: string }
  | { readonly status: 'already-current'; readonly buildId: string; readonly version: string }
  | { readonly status: 'no-valid-build' };

export function configuredTestFlightDistribution(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TestFlightDistributionConfig {
  const keyId = required(environment.SHANNON_ASC_KEY_ID, 'SHANNON_ASC_KEY_ID');
  // Individual App Store Connect keys currently use 12-character IDs, while
  // older/team keys commonly use 10. Accept both formats without weakening the
  // character set validation.
  if (!/^[A-Z0-9]{10,20}$/u.test(keyId)) throw new Error('SHANNON_ASC_KEY_ID is invalid');
  const privateKeyPath = required(environment.SHANNON_ASC_PRIVATE_KEY_PATH, 'SHANNON_ASC_PRIVATE_KEY_PATH');
  if (!privateKeyPath.startsWith('/')) throw new Error('SHANNON_ASC_PRIVATE_KEY_PATH must be absolute');
  const appId = resourceId(environment.SHANNON_ASC_APP_ID, 'SHANNON_ASC_APP_ID');
  const betaGroupId = resourceId(environment.SHANNON_ASC_BETA_GROUP_ID, 'SHANNON_ASC_BETA_GROUP_ID');
  const statePath = environment.SHANNON_ASC_STATE_PATH?.trim();
  return {
    keyId,
    privateKeyPath,
    appId,
    betaGroupId,
    ...(statePath ? { statePath } : {}),
  };
}

export function createIndividualAppStoreConnectToken(
  keyId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const header = encodeJson({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const payload = encodeJson({
    sub: 'user',
    iat: nowSeconds,
    exp: nowSeconds + 10 * 60,
    aud: 'appstoreconnect-v1',
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export async function distributeLatestInternalBuild(options: {
  readonly config: TestFlightDistributionConfig;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly readPrivateKey?: (path: string) => Promise<string>;
}): Promise<TestFlightDistributionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now?.() ?? new Date();
  const privateKey = await (options.readPrivateKey ?? readUtf8)(options.config.privateKeyPath);
  const token = createIndividualAppStoreConnectToken(
    options.config.keyId,
    privateKey,
    Math.floor(now.getTime() / 1_000),
  );
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(new URL(path, appStoreConnectOrigin), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      const detail = await safeErrorDetail(response);
      throw new Error(`APP_STORE_CONNECT_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };

  const query = new URLSearchParams({
    'filter[app]': options.config.appId,
    'filter[processingState]': 'VALID',
    'fields[builds]': 'version,uploadedDate,processingState,expired,buildAudienceType',
    sort: '-uploadedDate',
    limit: '10',
  });
  const builds = await request<JsonApiList<BuildResource>>(`/v1/builds?${query.toString()}`);
  const latest = builds.data
    .filter(build =>
      build.type === 'builds'
      && build.attributes.processingState === 'VALID'
      && build.attributes.expired !== true
      && build.attributes.buildAudienceType === 'INTERNAL_ONLY'
    )
    .sort(compareBuildsNewestFirst)[0];
  if (!latest) return { status: 'no-valid-build' };
  const version = latest.attributes.version ?? 'unknown';

  const state = options.config.statePath ? await readState(options.config.statePath) : null;
  if (state?.lastDistributedBuildId === latest.id) {
    return { status: 'already-current', buildId: latest.id, version };
  }

  const linked = await request<JsonApiList<ResourceLinkage>>(
    `/v1/betaGroups/${encodeURIComponent(options.config.betaGroupId)}/relationships/builds?limit=200`,
  );
  if (!linked.data.some(build => build.type === 'builds' && build.id === latest.id)) {
    await request<void>(
      `/v1/betaGroups/${encodeURIComponent(options.config.betaGroupId)}/relationships/builds`,
      {
        method: 'POST',
        body: JSON.stringify({ data: [{ type: 'builds', id: latest.id }] }),
      },
    );
  }

  if (options.config.statePath) {
    await writeState(options.config.statePath, {
      lastDistributedBuildId: latest.id,
      version,
      distributedAt: now.toISOString(),
    });
  }
  return {
    status: linked.data.some(build => build.type === 'builds' && build.id === latest.id)
      ? 'already-current'
      : 'distributed',
    buildId: latest.id,
    version,
  };
}

function compareBuildsNewestFirst(left: BuildResource, right: BuildResource): number {
  const leftVersion = numericVersion(left.attributes.version);
  const rightVersion = numericVersion(right.attributes.version);
  if (leftVersion && rightVersion) {
    const length = Math.max(leftVersion.length, rightVersion.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
      if (difference !== 0) return difference;
    }
  }
  return Date.parse(right.attributes.uploadedDate ?? '') - Date.parse(left.attributes.uploadedDate ?? '');
}

function numericVersion(version: string | undefined): number[] | null {
  return version && /^\d+(?:\.\d+)*$/u.test(version)
    ? version.split('.').map(part => Number(part))
    : null;
}

async function main(): Promise<void> {
  const delivery = new SQLiteTestFlightDeliveryStore(configuredDatabasePath());
  const checkedAt = new Date().toISOString();
  try {
    const result = await distributeLatestInternalBuild({ config: configuredTestFlightDistribution() });
    delivery.recordResult(result, checkedAt);
    console.log(`[testflight-distributor] ${result.status}${'version' in result ? ` build=${result.version}` : ''}`);
  } catch (error) {
    const recorded = delivery.recordFailure(error, checkedAt);
    console.error(`[testflight-distributor] failed code=${recorded.failureCode} notification=${recorded.notificationQueued ? 'queued' : 'suppressed'}`);
    throw error;
  } finally {
    delivery.close();
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function resourceId(value: string | undefined, name: string): string {
  const normalized = required(value, name);
  if (!/^[A-Za-z0-9-]{1,160}$/u.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

async function readUtf8(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

async function readState(path: string): Promise<DistributionState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<DistributionState>;
    return typeof parsed.lastDistributedBuildId === 'string'
      && typeof parsed.version === 'string'
      && typeof parsed.distributedAt === 'string'
      ? parsed as DistributionState
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(path: string, state: DistributionState): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, absolute);
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { errors?: Array<{ title?: string; detail?: string }> };
    const first = body.errors?.[0];
    return [first?.title, first?.detail].filter(Boolean).join(' — ').slice(0, 500);
  } catch {
    return response.statusText.slice(0, 200);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(`[testflight-distributor] ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
