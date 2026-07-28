import {useCallback, useEffect, useState} from 'react';

import * as Comlink from 'comlink';

import {authenticatePasskey, registerPasskey} from './webauthn';
import type {VaultView, WorkerApi, WorkerSnapshot} from './worker-api';

const worker = Comlink.wrap<WorkerApi>(
  new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'}),
);

type WorkerAction = () => Promise<WorkerSnapshot>;

/**
 * Own the page-side worker subscription and expose UI-safe worker actions.
 */
export function useWorker() {
  const [snapshot, setSnapshot] = useState<WorkerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const run = useCallback(
    async (action: WorkerAction): Promise<void> => {
      setError(null);
      setWorking(true);
      try {
        setSnapshot(await action());
      } catch (cause) {
        reportError(cause);
      } finally {
        setWorking(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    let active = true;
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
        }
      })
      .catch(reportError);

    return () => {
      active = false;
      void worker.disconnect();
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

  const connect = useCallback(
    () => run(() => worker.connect(websocketEndpoint(), 'Browser')),
    [run],
  );
  const disconnect = useCallback(() => run(() => worker.disconnect()), [run]);
  const forgetPairing = useCallback(
    () =>
      run(async () => {
        const endpoint = websocketEndpoint();
        await worker.forgetPairing(endpoint);
        return worker.connect(endpoint, 'Browser');
      }),
    [run],
  );
  const lock = useCallback(() => run(() => worker.lock()), [run]);
  const destroy = useCallback(() => run(() => worker.destroy()), [run]);
  const addKey = useCallback((pem: string) => run(() => worker.addKey(pem)), [run]);
  const removeKey = useCallback(
    (keyId: string) => run(() => worker.removeKey(keyId)),
    [run],
  );

  return {
    snapshot,
    error,
    working,
    createVault,
    unlock,
    connect,
    disconnect,
    forgetPairing,
    lock,
    destroy,
    addKey,
    removeKey,
  };
}

function websocketEndpoint(): string {
  const endpoint = new URL('/api/agent', window.location.href);
  endpoint.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.href;
}
