import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {createPushSubscription} from './push';
import {useServiceWorker} from './ServiceWorkerProvider';
import {useWorker} from './WorkerProvider';

export type NotificationState =
  | 'unavailable'
  | 'initializing'
  | 'disabled'
  | 'denied'
  | 'enabling'
  | 'enabled'
  | 'error';

interface NotificationsContextValue {
  state: NotificationState;
  error: string | null;
  canEnable: boolean;
  enable(): Promise<boolean>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({children}: {children: ReactNode}) {
  const {
    state: serviceWorkerState,
    registration,
    error: serviceWorkerError,
  } = useServiceWorker();
  const {snapshot, registerPushSubscription} = useWorker();
  const supported = 'Notification' in globalThis && 'PushManager' in globalThis;
  const [state, setState] = useState<NotificationState>(
    supported && serviceWorkerState !== 'unavailable' ? 'initializing' : 'unavailable',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || serviceWorkerState === 'unavailable') {
      setState('unavailable');
      return;
    }
    if (serviceWorkerState === 'error') {
      setState('error');
      return;
    }
    if (!registration) {
      setState('initializing');
      return;
    }

    let active = true;

    registration.pushManager
      .getSubscription()
      .then(subscription => {
        if (!active) {
          return;
        }

        if (subscription) {
          setState('enabled');
        } else if (Notification.permission === 'denied') {
          setState('denied');
        } else {
          setState('disabled');
        }
      })
      .catch(cause => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setState('error');
        }
      });

    return () => {
      active = false;
    };
  }, [registration, serviceWorkerState, supported]);

  const applicationServerKey = snapshot?.connection.vapidPublicKey;
  const canEnable =
    state === 'disabled' &&
    registration !== null &&
    snapshot?.connection.status === 'connected' &&
    applicationServerKey !== null;

  const enable = useCallback(async (): Promise<boolean> => {
    setError(null);
    setState('enabling');

    try {
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
      if (!(await registerPushSubscription(subscription))) {
        throw new Error('could not register push subscription');
      }

      setState('enabled');
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState(supported && Notification.permission === 'denied' ? 'denied' : 'disabled');
      return false;
    }
  }, [
    applicationServerKey,
    registerPushSubscription,
    registration,
    snapshot?.connection.status,
    supported,
  ]);

  const value = useMemo(
    () => ({state, error: error ?? serviceWorkerError, canEnable, enable}),
    [state, error, serviceWorkerError, canEnable, enable],
  );

  return <NotificationsContext value={value}>{children}</NotificationsContext>;
}

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (!value) {
    throw new Error('useNotifications must be used within a NotificationsProvider');
  }

  return value;
}
