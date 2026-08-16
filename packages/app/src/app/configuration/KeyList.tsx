import {type FormEvent, useState} from 'react';

import type {KeyType} from 'app/vault/types';
import type {KeyView} from 'app/worker/api';

import {useWorker} from '../WorkerProvider';

const KEY_FORMAT: Record<KeyType, string> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA P-256',
};

export function KeyList() {
  const {snapshot, working, error, unlock, addKey, removeKey} = useWorker();
  const [readingClipboard, setReadingClipboard] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [pendingPem, setPendingPem] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');

  const vault = snapshot?.vault;
  const keys = vault && vault.status !== 'no-vault' ? vault.vault.keys : [];

  async function readFromClipboard(): Promise<void> {
    setClipboardError(null);
    setReadingClipboard(true);

    try {
      const pem = (await navigator.clipboard.readText()).trim();
      if (pem === '') {
        setClipboardError('The clipboard is empty.');
        return;
      }

      setKeyName('');
      setPendingPem(pem);
    } catch (cause) {
      setClipboardError(
        cause instanceof Error ? cause.message : 'Could not read from the clipboard.',
      );
    } finally {
      setReadingClipboard(false);
    }
  }

  async function saveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setClipboardError(null);

    const name = keyName.trim();
    if (!pendingPem || name === '') {
      setClipboardError('Enter a name for this key.');
      return;
    }

    try {
      if (!vault || vault.status === 'no-vault') {
        setClipboardError('No vault is configured.');
        return;
      }

      if (vault.status === 'locked' && !(await unlock(vault.vault))) {
        return;
      }

      if (await addKey(pendingPem, name)) {
        setPendingPem(null);
        setKeyName('');
      }
    } catch (cause) {
      setClipboardError(
        cause instanceof Error ? cause.message : 'Could not add this key.',
      );
    }
  }

  function remove(key: KeyView): void {
    if (!window.confirm(`Remove “${key.name || key.fingerprint}”?`)) {
      return;
    }

    void removeKey(key.id);
  }

  return (
    <section
      aria-labelledby="private-keys-heading"
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]"
    >
      <header className="px-4 pt-6 pr-14 pb-3">
        <h2
          id="private-keys-heading"
          className="text-foreground-muted text-[11px] font-semibold tracking-[0.16em] uppercase"
        >
          Private Keys
        </h2>
      </header>

      <div className="overflow-y-auto overscroll-contain px-4">
        {keys.length === 0 ? (
          <p className="border-border-strong text-foreground-faint rounded-lg border border-dashed px-4 py-8 text-center text-xs">
            No private keys configured.
          </p>
        ) : (
          <ul className="grid gap-2" aria-label="Private keys">
            {keys.map(key => (
              <li key={key.id}>
                <article className="border-border bg-surface rounded-lg border p-3.5 shadow-xs">
                  <header className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <h3 className="text-foreground-strong truncate text-xs font-semibold">
                        {key.name || key.type}
                      </h3>
                      <span className="text-foreground-faint shrink-0 text-[9px] font-semibold tracking-[0.1em] uppercase">
                        {KEY_FORMAT[key.type]}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${key.name || key.fingerprint}`}
                      disabled={working}
                      className="text-foreground-faint hover:bg-surface-hover hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors disabled:cursor-default disabled:opacity-40"
                      onClick={() => remove(key)}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="size-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M2.5 4.5h11M6 2.5h4l.5 2h-5l.5-2ZM4 4.5l.75 9h6.5l.75-9M6.5 7v4M9.5 7v4" />
                      </svg>
                    </button>
                  </header>

                  <p
                    aria-label={`SHA256 fingerprint: ${key.fingerprint.slice('SHA256:'.length)}`}
                    className="text-foreground-subtle mt-1 whitespace-nowrap text-[9px] tracking-[-0.02em]"
                  >
                    {key.fingerprint.slice('SHA256:'.length)}
                  </p>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {(clipboardError || error) && (
          <p role="alert" className="text-danger mb-3 text-xs">
            {clipboardError ?? error}
          </p>
        )}
        {pendingPem ? (
          <form className="grid gap-3" onSubmit={event => void saveKey(event)}>
            <label className="text-foreground-muted grid gap-1.5 text-xs font-semibold">
              Key name
              <input
                autoFocus
                required
                type="text"
                value={keyName}
                className="border-border-strong bg-surface text-foreground focus:border-border-primary h-12 rounded-lg border px-3 text-sm font-normal outline-none"
                onChange={event => setKeyName(event.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={working}
                className="border-border-strong bg-surface text-foreground-muted h-12 rounded-lg border px-4 text-xs font-semibold tracking-[0.08em] uppercase disabled:opacity-40"
                onClick={() => {
                  setPendingPem(null);
                  setKeyName('');
                  setClipboardError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={working}
                className="border-border-primary bg-primary text-primary-foreground disabled:border-border disabled:bg-surface-disabled disabled:text-foreground-disabled h-12 rounded-lg border px-4 text-xs font-semibold tracking-[0.08em] uppercase"
              >
                Save key
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            disabled={working || readingClipboard}
            className="border-border-primary bg-primary text-primary-foreground disabled:border-border disabled:bg-surface-disabled disabled:text-foreground-disabled h-12 w-full rounded-lg border px-5 text-xs font-semibold tracking-[0.08em] uppercase shadow-sm transition active:scale-[0.99] disabled:shadow-none disabled:active:scale-100"
            onClick={() => void readFromClipboard()}
          >
            {readingClipboard ? 'Reading clipboard…' : 'Add from clipboard'}
          </button>
        )}
      </footer>
    </section>
  );
}
