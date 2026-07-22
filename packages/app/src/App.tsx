import {useEffect, useState} from 'react';

import * as Comlink from 'comlink';

import {authenticatePasskey, registerPasskey} from 'app/webauthn';
import type {VaultSnapshot, VaultView, WorkerApi} from 'app/worker-api';

const worker = Comlink.wrap<WorkerApi>(
  new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'}),
);

/**
 * Minimal, unstyled UI over the worker's vault API. Every action returns a fresh
 * snapshot, which drives the render.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [pem, setPem] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    worker.getState().then(setSnapshot, reportError);
  }, []);

  function reportError(cause: unknown): void {
    setError(cause instanceof Error ? cause.message : String(cause));
  }

  async function run(action: () => Promise<VaultSnapshot>): Promise<void> {
    setError(null);
    try {
      setSnapshot(await action());
    } catch (cause) {
      reportError(cause);
    }
  }

  function createVault(): Promise<void> {
    return run(async () => worker.createVault(await registerPasskey()));
  }

  function unlock(view: VaultView): Promise<void> {
    return run(async () => {
      const [passkey] = view.passkeys;
      return worker.unlock(await authenticatePasskey(passkey.credentialId, passkey.salt));
    });
  }

  async function addKey(): Promise<void> {
    await run(() => worker.addKey(pem));
    setPem('');
  }

  return (
    <main>
      <h1>agent-witness</h1>
      {error && <p role="alert">Error: {error}</p>}
      {renderContent()}
    </main>
  );

  function renderContent() {
    if (!snapshot) {
      return <p>Loading…</p>;
    }

    if (snapshot.status === 'no-vault') {
      return (
        <button type="button" onClick={createVault}>
          Create vault
        </button>
      );
    }

    if (snapshot.status === 'locked') {
      const {vault: view} = snapshot;
      return (
        <>
          <p>Vault locked ({view.keys.length} keys)</p>
          <button type="button" onClick={() => unlock(view)}>
            Unlock with {view.passkeys[0].label}
          </button>
          <button type="button" onClick={() => run(() => worker.destroy())}>
            Delete vault
          </button>
        </>
      );
    }

    const {vault: view} = snapshot;
    return (
      <>
        <button type="button" onClick={() => run(() => worker.lock())}>
          Lock
        </button>
        <button type="button" onClick={() => run(() => worker.destroy())}>
          Delete vault
        </button>
        <ul>
          {view.keys.map(key => (
            <li key={key.id}>
              {key.name} — {key.type} — {key.fingerprint}{' '}
              <button type="button" onClick={() => run(() => worker.removeKey(key.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <textarea
          value={pem}
          onChange={event => setPem(event.target.value)}
          placeholder="Paste an OpenSSH private key"
          rows={8}
          cols={70}
        />
        <div>
          <button type="button" onClick={addKey} disabled={pem.trim() === ''}>
            Add SSH key
          </button>
        </div>
      </>
    );
  }
}
