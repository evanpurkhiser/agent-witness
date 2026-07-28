import {type FormEvent, useState} from 'react';

import {useWorker} from './use-worker';

// REVIEW: Let's move the use-worker and this app component into a `app` module
// in the source root, so we can split out the worker stuff from the app a bit
// more.

export function App() {
  const {
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
  } = useWorker();
  const [pem, setPem] = useState('');

  async function submitKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await addKey(pem);
    setPem('');
  }

  if (!snapshot) {
    return (
      <main>
        <h1>agent-witness</h1>
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </main>
    );
  }

  const {connection, vault} = snapshot;

  return (
    <main>
      <header>
        <h1>agent-witness</h1>
        <p>Remote SSH agent</p>
      </header>

      {error && <p role="alert">{error}</p>}
      {connection.error && <p role="alert">{connection.error}</p>}

      <section aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
        <dl>
          <dt>Status</dt>
          <dd>{connection.status}</dd>
          {connection.serverId && (
            <>
              <dt>Server</dt>
              <dd>{connection.serverId}</dd>
            </>
          )}
        </dl>
        {connection.status === 'connected' ? (
          <button type="button" disabled={working} onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            disabled={working || connection.status === 'connecting'}
            onClick={connect}
          >
            {connection.status === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {connection.status === 'rejected' && (
          <button type="button" disabled={working} onClick={forgetPairing}>
            Forget pairing and reconnect
          </button>
        )}
      </section>

      {connection.pendingRequests > 0 && (
        <section aria-labelledby="requests-heading" aria-live="polite">
          <h2 id="requests-heading">Pending requests</h2>
          <p>
            {connection.pendingRequests}{' '}
            {connection.pendingRequests === 1 ? 'request is' : 'requests are'} waiting.
          </p>
          {vault.status === 'locked' && (
            <button type="button" disabled={working} onClick={() => unlock(vault.vault)}>
              Unlock and approve
            </button>
          )}
          {vault.status === 'unlocked' && <p>Approving requests…</p>}
          {vault.status === 'no-vault' && (
            <p>Create a vault and add an SSH key before approving requests.</p>
          )}
        </section>
      )}

      <section aria-labelledby="vault-heading">
        <h2 id="vault-heading">Vault</h2>
        {vault.status === 'no-vault' && (
          <>
            <p>No vault configured.</p>
            <button type="button" disabled={working} onClick={createVault}>
              Create vault
            </button>
          </>
        )}

        {vault.status === 'locked' && (
          <>
            <p>Locked. {vault.vault.keys.length} keys available.</p>
            <button type="button" disabled={working} onClick={() => unlock(vault.vault)}>
              Unlock with {vault.vault.passkeys[0]?.label ?? 'passkey'}
            </button>
            <button type="button" disabled={working} onClick={destroy}>
              Delete vault
            </button>
          </>
        )}

        {vault.status === 'unlocked' && (
          <>
            <p>Unlocked. Requests are approved until the vault is locked.</p>
            <button type="button" disabled={working} onClick={lock}>
              Lock
            </button>
            <button type="button" disabled={working} onClick={destroy}>
              Delete vault
            </button>

            <section aria-labelledby="keys-heading">
              <h3 id="keys-heading">SSH keys</h3>
              {vault.vault.keys.length === 0 ? (
                <p>No SSH keys configured.</p>
              ) : (
                <ul>
                  {vault.vault.keys.map(key => (
                    <li key={key.id}>
                      <strong>{key.name}</strong>
                      <dl>
                        <dt>Type</dt>
                        <dd>{key.type}</dd>
                        <dt>Fingerprint</dt>
                        <dd>{key.fingerprint}</dd>
                      </dl>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => removeKey(key.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={submitKey}>
                <label htmlFor="private-key">OpenSSH private key</label>
                <textarea
                  id="private-key"
                  value={pem}
                  onChange={event => setPem(event.target.value)}
                  rows={8}
                  cols={70}
                />
                <button type="submit" disabled={working || pem.trim() === ''}>
                  Add SSH key
                </button>
              </form>
            </section>
          </>
        )}
      </section>

      {working && <p aria-live="polite">Working…</p>}
    </main>
  );
}
