import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import * as Comlink from 'comlink';

import type {PushSubscriptionRegistration} from 'app/remote/session';
import {authenticatePasskey, registerPasskey} from 'app/webauthn';
import type {VaultView, WorkerApi, WorkerSnapshot} from 'app/worker/api';

const worker = Comlink.wrap<WorkerApi>(
  new Worker(new URL('../worker/index.ts', import.meta.url), {type: 'module'}),
);

type WorkerAction = () => Promise<WorkerSnapshot>;

interface WorkerContextValue {
  snapshot: WorkerSnapshot | null;
  error: string | null;
  working: boolean;
  createVault(): Promise<boolean>;
  unlock(view: VaultView): Promise<boolean>;
  forgetPairing(): Promise<boolean>;
  registerPushSubscription(subscription: PushSubscriptionRegistration): Promise<boolean>;
  lock(): Promise<boolean>;
  destroy(): Promise<boolean>;
  addKey(pem: string, name?: string): Promise<boolean>;
  removeKey(keyId: string): Promise<boolean>;
}

const WorkerContext = createContext<WorkerContextValue | null>(null);

export function WorkerProvider({children}: {children: ReactNode}) {
  const [snapshot, setSnapshot] = useState<WorkerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const run = useCallback(
    async (action: WorkerAction): Promise<boolean> => {
      setError(null);
      setWorking(true);
      try {
        setSnapshot(await action());
        return true;
      } catch (cause) {
        reportError(cause);
        return false;
      } finally {
        setWorking(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    let active = true;
    const reconcileConnection = () => {
      void worker.setConnectionActive(
        document.visibilityState === 'visible' && navigator.onLine,
      );
    };
    const pauseConnection = () => {
      void worker.setConnectionActive(false);
    };
    const listener = Comlink.proxy((next: WorkerSnapshot) => {
      if (active) {
        setSnapshot(next);
      }
    });

    worker
      .subscribe(listener)
      .then(async initial => {
        if (!active) {
          return;
        }

        setSnapshot(initial);
        const connected = await worker.connect(websocketEndpoint(), 'Browser');
        if (active) {
          setSnapshot(connected);
          reconcileConnection();
        }
      })
      .catch(reportError);

    document.addEventListener('visibilitychange', reconcileConnection);
    window.addEventListener('pagehide', pauseConnection);
    window.addEventListener('pageshow', reconcileConnection);
    window.addEventListener('online', reconcileConnection);
    window.addEventListener('offline', reconcileConnection);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', reconcileConnection);
      window.removeEventListener('pagehide', pauseConnection);
      window.removeEventListener('pageshow', reconcileConnection);
      window.removeEventListener('online', reconcileConnection);
      window.removeEventListener('offline', reconcileConnection);
    };
  }, [reportError]);

  const createVault = useCallback(
    () => run(async () => worker.createVault(await registerPasskey())),
    [run],
  );

  const unlock = useCallback(
    (view: VaultView) =>
      run(async () => {
        const [passkey] = view.passkeys;
        if (!passkey) {
          throw new Error('vault has no enrolled passkeys');
        }

        const prfOutput = await authenticatePasskey(passkey.credentialId, passkey.salt);
        return worker.unlock(prfOutput);
      }),
    [run],
  );

  const forgetPairing = useCallback(
    () =>
      run(() => {
        const endpoint = websocketEndpoint();
        return worker.forgetPairing(endpoint);
      }),
    [run],
  );
  const registerPushSubscription = useCallback(
    (subscription: PushSubscriptionRegistration) =>
      run(() => worker.registerPushSubscription(subscription)),
    [run],
  );
  const lock = useCallback(() => run(() => worker.lock()), [run]);
  const destroy = useCallback(() => run(() => worker.destroy()), [run]);
  const addKey = useCallback(
    (pem: string, name?: string) => run(() => worker.addKey(pem, name)),
    [run],
  );
  const removeKey = useCallback(
    (keyId: string) => run(() => worker.removeKey(keyId)),
    [run],
  );

  const value = useMemo(
    () => ({
      snapshot,
      error,
      working,
      createVault,
      unlock,
      forgetPairing,
      registerPushSubscription,
      lock,
      destroy,
      addKey,
      removeKey,
    }),
    [
      snapshot,
      error,
      working,
      createVault,
      unlock,
      forgetPairing,
      registerPushSubscription,
      lock,
      destroy,
      addKey,
      removeKey,
    ],
  );

  return <WorkerContext value={value}>{children}</WorkerContext>;
}

export function useWorker(): WorkerContextValue {
  const value = useContext(WorkerContext);
  if (!value) {
    throw new Error('useWorker must be used within a WorkerProvider');
  }

  return value;
}

function websocketEndpoint(): string {
  const endpoint = new URL('/api/agent', window.location.href);
  endpoint.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.href;
}
