import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { WAITING_TESTFLIGHT_DASHBOARD, type TestFlightDeliveryReader } from '../../integrations/testflight/store/testflightDeliveryStore.js';
import { badRequest, objectBody, validBoundedString, validScopeKey } from './apiValidation.js';

/**
 * The TestFlight delivery routes of the API kernel, moved out of `apiKernel.ts` for its size (Syzygy ADR-0008 §10) with no
 * change: the dashboard, and the owner's confirmation of a gate. Null for any other request.
 */
export function dispatchTestFlightRequest(
  request: ApiRequest, dependencies: { testFlightDelivery: TestFlightDeliveryReader | null; now: () => string },
): ApiResponse | null {
  if (request.method === 'GET' && request.path === '/v1/testflight/delivery') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return {
      status: 200,
      body: dependencies.testFlightDelivery?.dashboard(30, scopeKey) ?? WAITING_TESTFLIGHT_DASHBOARD,
    };
  }

  if (request.method === 'POST' && request.path === '/v1/testflight/delivery/confirm') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validBoundedString(request.body.buildVersion, 80)) return badRequest('buildVersion is invalid');
    if (request.body.gate !== 'install' && request.body.gate !== 'smoke') return badRequest('gate is invalid');
    if (!dependencies.testFlightDelivery?.confirmGate) return { status: 503, body: { error: 'TESTFLIGHT_DELIVERY_UNAVAILABLE' } };
    try {
      return {
        status: 200,
        body: dependencies.testFlightDelivery.confirmGate(scopeKey, request.body.buildVersion, request.body.gate, dependencies.now()),
      };
    } catch (error) {
      if (error instanceof Error && (error.message === 'TESTFLIGHT_BUILD_NOT_DISTRIBUTED'
        || error.message === 'TESTFLIGHT_INSTALL_REQUIRED')) {
        return { status: 409, body: { error: error.message } };
      }
      throw error;
    }
  }
  return null;
}
