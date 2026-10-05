/**
 * Her desktop body inside one of the owner's apps (roadmap A17: the Mac app shows her standing on the desktop).
 *
 * The Mac app is two things on one paired device: one of the owner's apps (Talk, his voice calls of A16, private
 * listening, the app look) and, while its desktop window is up, her full body (presence reads, who can see her,
 * looks at the room, what it did with her messages, touches and who is at the PC). The server's rules tell the two
 * apart by device: an app's call is "a call elsewhere" for her other bodies and is never refused, a full body's call
 * is neither; an app's read of `/v1/initiatives` is an ordinary read, a body's read leaves out what an app says.
 * One device cannot be both at once, so the body part speaks for a device of its own, derived from the app's:
 *
 * - A request that carries `X-Shannon-Body: desktop` on a body route (`/v1/body/*`) or on
 *   `GET /v1/initiatives` is taken as coming from `<deviceId>.desktop-body` of the same paired device.
 * - Every other request, and every request without the header, is the app's, exactly as before.
 *
 * Nothing is authenticated differently: the token is the app's, the body can only ever speak for the one body
 * derived from its own device, and unpairing the app ends both. A fixed-token caller (no paired device) is never
 * given a body identity.
 */
export const DESKTOP_BODY_HEADER = 'x-shannon-body';
export const DESKTOP_BODY_HEADER_VALUE = 'desktop';
export const DESKTOP_BODY_SUFFIX = '.desktop-body';

/** The body identity of a paired app's desktop window. */
export const desktopBodyDeviceId = (deviceId: string): string => `${deviceId}${DESKTOP_BODY_SUFFIX}`;
export const isDesktopBodyDeviceId = (deviceId: string): boolean => deviceId.endsWith(DESKTOP_BODY_SUFFIX);

/** What the server knows of a paired device when it asks whether it has a desktop body. */
export interface DesktopBodyCandidate {
  /** Her Minecraft body's token: never another body. */
  isGame: boolean;
  /** The device's own body registration (its figure), or null. Read only when asked. */
  registration: () => { surface?: string } | null;
  /** Which of the owner's apps the device has said it is (`ownerCallElsewhere.ts`, `SQLiteOwnerCallFacts.surface`). */
  appSurface: () => string | undefined;
}

/**
 * Only the Mac app has a desktop body: a device that has said it is the Mac app (`appSurface` is `mac`), whose own
 * registration, if it has one, is the Mac's. A device that has not said which app it is is refused, and so is one
 * registered anywhere else (the phone's figure, a Windows body, a registration without a surface). Fails closed.
 */
export function mayHaveDesktopBody(device: DesktopBodyCandidate): boolean {
  if (device.isGame) return false;
  // A store that cannot be read (a corrupt row, a closed database) says no: the request goes on as the app's own.
  try {
    const registration = device.registration();
    if (registration && registration.surface !== 'mac') return false;
    return device.appSurface() === 'mac';
  } catch { return false; }
}

/** Whether the header names the desktop body. Any other value, or none, is the app. */
export function namesDesktopBody(header: string | readonly string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().toLowerCase() === DESKTOP_BODY_HEADER_VALUE;
}

/**
 * The routes the body part may speak on: her body's routes, and reading her messages. The app's look answer
 * (`/v1/app/looks/{id}`) is not under `/v1/body/` and stays the app's.
 */
export function desktopBodyMaySpeakOn(method: string | undefined, path: string): boolean {
  if (path.startsWith('/v1/body/')) return true;
  return method === 'GET' && path === '/v1/initiatives';
}

/**
 * The device a paired request speaks for: its own, or its desktop body's on the routes above. `mayDerive` is asked only
 * then, and says no for a device that may never be another body (her Minecraft body, which `serverMinecraftBodyWiring.ts`
 * refuses with the header; any device that is not the Mac app, `mayHaveDesktopBody`).
 */
export function requestDeviceId(
  deviceId: string, header: string | readonly string[] | undefined, method: string | undefined, path: string,
  mayDerive: () => boolean = () => true,
): string {
  return namesDesktopBody(header) && desktopBodyMaySpeakOn(method, path) && mayDerive() ? desktopBodyDeviceId(deviceId) : deviceId;
}
