import {useCallback, useEffect, useState} from 'react';

import {createPushSubscription, registerPushServiceWorker} from './push';
import {useWorker} from './WorkerProvider';

export function useServiceWorker() {
  const {snapshot, registerPushSubscription} = useWorker();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [pushRegistered, setPushRegistered] = useState(false);

  useEffect(() => {
    let active = true;

    async function register(): Promise<void> {
      try {
        const next = await registerPushServiceWorker();
        const subscription = await next.pushManager.getSubscription();
        if (active) {
          setRegistration(next);
          setPushRegistered(subscription !== null);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    void register();

    return () => {
      active = false;
    };
  }, []);

  const enablePushNotifications = useCallback(async () => {
    setError(null);
    setWorking(true);

    try {
      const applicationServerKey = snapshot?.connection.vapidPublicKey;
      if (!registration) {
        throw new Error('service worker is not ready');
      }
      if (snapshot?.connection.status !== 'connected' || !applicationServerKey) {
        throw new Error('remote session is not connected');
      }

      const subscription = await createPushSubscription(
        registration,
        applicationServerKey,
      );
      if (await registerPushSubscription(subscription)) {
        setPushRegistered(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [registerPushSubscription, registration, snapshot]);

  return {
    error,
    working,
    enablePushNotifications,
    pushRegistrationReady:
      registration !== null &&
      snapshot?.connection.status === 'connected' &&
      snapshot.connection.vapidPublicKey !== null,
    pushRegistered,
  };
}
