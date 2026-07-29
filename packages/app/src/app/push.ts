import type {PushSubscriptionRegistration} from 'app/remote/session';
import type {Bytes} from 'app/utils/bytes';
import {b64urlencode} from 'app/utils/bytes';

/**
 * Register the root-scoped service worker before notification UI is enabled.
 */
export function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) {
    throw new Error('Web Push is not supported by this browser');
  }

  const script = import.meta.env.DEV ? '/service-worker.ts' : '/service-worker.js';
  return navigator.serviceWorker.register(script, {scope: '/'});
}

/**
 * Request a browser push subscription and serialize its encryption material.
 *
 * Call this directly from a user gesture so the browser may show its
 * notification permission prompt.
 */
export async function createPushSubscription(
  registration: ServiceWorkerRegistration,
  applicationServerKey: Bytes,
): Promise<PushSubscriptionRegistration> {
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  return serializePushSubscription(subscription);
}

export function serializePushSubscription(
  subscription: PushSubscription,
): PushSubscriptionRegistration {
  const p256Dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256Dh || !auth) {
    throw new Error('push subscription is missing encryption keys');
  }

  return {
    endpoint: subscription.endpoint,
    expirationTime:
      subscription.expirationTime === null
        ? null
        : Math.trunc(subscription.expirationTime),
    p256Dh: b64urlencode(new Uint8Array(p256Dh)),
    auth: b64urlencode(new Uint8Array(auth)),
  };
}
