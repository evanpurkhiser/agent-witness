import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {registerServiceWorker} from './service-worker';

export type ServiceWorkerState = 'unavailable' | 'registering' | 'ready' | 'error';

interface ServiceWorkerContextValue {
  state: ServiceWorkerState;
  registration: ServiceWorkerRegistration | null;
  error: string | null;
}

const ServiceWorkerContext = createContext<ServiceWorkerContextValue | null>(null);

export function ServiceWorkerProvider({children}: {children: ReactNode}) {
  const supported = 'serviceWorker' in navigator;
  const [state, setState] = useState<ServiceWorkerState>(
    supported ? 'registering' : 'unavailable',
  );
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      return;
    }

    let active = true;

    registerServiceWorker()
      .then(next => {
        if (active) {
          setRegistration(next);
          setState('ready');
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
  }, [supported]);

  const value = useMemo(
    () => ({state, registration, error}),
    [state, registration, error],
  );

  return <ServiceWorkerContext value={value}>{children}</ServiceWorkerContext>;
}

export function useServiceWorker(): ServiceWorkerContextValue {
  const value = useContext(ServiceWorkerContext);
  if (!value) {
    throw new Error('useServiceWorker must be used within a ServiceWorkerProvider');
  }

  return value;
}
