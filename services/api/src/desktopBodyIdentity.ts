import { APP_LOOK_ROUTE_PREFIX } from './appLookContract.js';

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
 * - A request that carries `X-Shannon-Body: desktop` on a body route (`/v1/body/*`, not the app look) or on
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

/** Whether the header names the desktop body. Any other value, or none, is the app. */
export function namesDesktopBody(header: string | readonly string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().toLowerCase() === DESKTOP_BODY_HEADER_VALUE;
}

/** The routes the body part may speak on: her body's routes (not the app's look answer), and reading her messages. */
export function desktopBodyMaySpeakOn(method: string | undefined, path: string): boolean {
  if (path.startsWith(APP_LOOK_ROUTE_PREFIX)) return false;
  if (path.startsWith('/v1/body/')) return true;
  return method === 'GET' && path === '/v1/initiatives';
}

/** The device a paired request speaks for: its own, or its desktop body's on the routes above. */
export function requestDeviceId(deviceId: string, header: string | readonly string[] | undefined, method: string | undefined, path: string): string {
  return namesDesktopBody(header) && desktopBodyMaySpeakOn(method, path) ? desktopBodyDeviceId(deviceId) : deviceId;
}
