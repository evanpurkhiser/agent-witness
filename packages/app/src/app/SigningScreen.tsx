import {useLayoutEffect, useRef} from 'react';

import type {ConnectionSnapshot} from 'app/remote/session';
import type {VaultSnapshot} from 'app/worker/api';
import type {AgentEvent} from 'app/worker/events';

interface SigningScreenProps {
  connection: ConnectionSnapshot;
  events: AgentEvent[];
  vault: Exclude<VaultSnapshot, {status: 'no-vault'}>;
  working: boolean;
  error: string | null;
  onAuthorize(): void;
}

export function SigningScreen({
  connection,
  events,
  vault,
  working,
  error,
  onAuthorize,
}: SigningScreenProps) {
  const pendingRequests = connection.pendingRequests;
  const canAuthorize = pendingRequests > 0 && vault.status === 'locked' && !working;

  return (
    <main className="fixed inset-0 grid grid-rows-[minmax(0,1fr)_auto_auto] gap-3 bg-zinc-50 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] font-mono text-zinc-950">
      <EventLog events={events} error={error ?? connection.error} />

      <button
        type="button"
        className="h-16 w-full rounded-lg border border-zinc-950 bg-zinc-950 px-6 text-sm font-semibold tracking-[0.08em] text-white uppercase shadow-sm transition active:scale-[0.99] disabled:border-zinc-200 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none disabled:active:scale-100"
        disabled={!canAuthorize}
        onClick={onAuthorize}
      >
        {working
          ? 'Unlocking…'
          : pendingRequests > 0 && vault.status === 'unlocked'
            ? 'Authorizing…'
            : 'Authorize'}
      </button>

      <div className="flex justify-center">
        <ConnectionPill status={connection.status} />
      </div>
    </main>
  );
}

function EventLog({events, error}: {events: AgentEvent[]; error: string | null}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && followingRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }, [events.length, error]);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xs">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-200 px-3.5">
        <h1 className="text-[11px] font-semibold tracking-[0.16em] text-zinc-700 uppercase">
          Event log
        </h1>
        <span className="text-[10px] tabular-nums text-zinc-400">
          {String(events.length).padStart(3, '0')}
        </span>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        onScroll={event => {
          const element = event.currentTarget;
          followingRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        <div className="flex min-h-full flex-col justify-end">
          {events.length === 0 && !error ? (
            <p className="px-3.5 py-3 text-xs text-zinc-400">No events recorded.</p>
          ) : (
            events.map(event => <EventRow key={event.id} event={event} />)
          )}
          {error && (
            <div
              role="alert"
              className="grid grid-cols-[3.25rem_minmax(0,1fr)] px-3.5 py-2 text-xs"
            >
              <span className="text-red-400">error</span>
              <span className="text-red-700">{error}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EventRow({event}: {event: AgentEvent}) {
  return (
    <div
      className={`grid grid-cols-[3.25rem_minmax(0,1fr)] px-3.5 py-2 text-xs leading-5 ${event.type === 'request_pending' ? 'bg-amber-50 text-amber-950' : 'text-zinc-700'}`}
    >
      <time
        className="tabular-nums text-zinc-400"
        dateTime={new Date(event.at).toISOString()}
      >
        {formatTime(event.at)}
      </time>
      <EventMessage event={event} />
    </div>
  );
}

function EventMessage({event}: {event: AgentEvent}) {
  switch (event.type) {
    case 'vault_unlocked':
      return <span>Vault unlocked</span>;
    case 'vault_locked':
      return (
        <span>
          Vault locked <span className="text-zinc-400">({event.reason})</span>
        </span>
      );
    case 'request_pending':
      return (
        <span>
          <RequestId value={event.requestId} /> Pending {formatBytes(event.bytes)} signing
          request
        </span>
      );
    case 'request_signing':
      return (
        <span>
          <RequestId value={event.requestId} /> Signing {formatBytes(event.bytes)} with{' '}
          <Token title={event.fingerprint}>{shortFingerprint(event.fingerprint)}</Token>{' '}
          key
        </span>
      );
    case 'request_closed':
      return (
        <span className="text-zinc-500">
          <RequestId value={event.requestId} /> Request closed
        </span>
      );
  }
}

function RequestId({value}: {value: string}) {
  return <Token title={value}>{value.slice(0, 8)}</Token>;
}

function Token({children, title}: {children: string; title: string}) {
  return (
    <code
      title={title}
      className="mr-1 inline-flex rounded border border-zinc-200 bg-zinc-50 px-1 py-px text-[10px] leading-4 text-zinc-600"
    >
      {children}
    </code>
  );
}

function ConnectionPill({status}: {status: ConnectionSnapshot['status']}) {
  const dotColor = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-500',
    reconnecting: 'bg-amber-500',
    rejected: 'bg-red-500',
    error: 'bg-red-500',
  }[status];

  return (
    <div className="flex h-7 items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase shadow-xs">
      <span className={`size-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      {status}
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatBytes(bytes: number): string {
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

function shortFingerprint(fingerprint: string): string {
  const value = fingerprint.startsWith('SHA256:')
    ? fingerprint.slice('SHA256:'.length)
    : fingerprint;
  return value.length > 10 ? `${value.slice(0, 10)}…` : value;
}
