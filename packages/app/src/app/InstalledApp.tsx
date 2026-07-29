import {type FormEvent, useState} from 'react';

import {useServiceWorker} from './use-service-worker';
import {useWorker, WorkerProvider} from './WorkerProvider';

export function InstalledApp() {
  return (
    <WorkerProvider>
      <InstalledAppContent />
    </WorkerProvider>
  );
}

function InstalledAppContent() {
  const {
    snapshot,
    error,
    working,
    createVault,
    unlock,
    forgetPairing,
    lock,
    destroy,
    addKey,
    removeKey,
  } = useWorker();
  const {
    error: pushError,
    working: pushWorking,
    enablePushNotifications,
    pushRegistrationReady,
    pushRegistered,
  } = useServiceWorker();
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

      <section aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
        <dl>
          <dt>Status</dt>
          <dd>{connection.status}</dd>
          {connection.error && (
            <>
              <dt>Error</dt>
              <dd role="alert">{connection.error}</dd>
            </>
          )}
          {connection.serverId && (
            <>
              <dt>Server</dt>
              <dd>{connection.serverId}</dd>
            </>
          )}
        </dl>
        {connection.status === 'rejected' && (
          <button type="button" disabled={working} onClick={forgetPairing}>
            Forget pairing and reconnect
          </button>
        )}
      </section>

      <section aria-labelledby="notifications-heading">
        <h2 id="notifications-heading">Notifications</h2>
        {pushError && <p role="alert">{pushError}</p>}
        {pushRegistered ? (
          <p>Notifications enabled.</p>
        ) : (
          <>
            <p>Enable notifications for new SSH authentication requests.</p>
            <button
              type="button"
              disabled={working || pushWorking || !pushRegistrationReady}
              onClick={enablePushNotifications}
            >
              Enable notifications
            </button>
          </>
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
