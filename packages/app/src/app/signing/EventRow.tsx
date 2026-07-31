import type {AgentEvent} from 'app/worker/events';

export function EventRow({event}: {event: AgentEvent}) {
  return (
    <li
      className={`grid grid-cols-[3.25rem_minmax(0,1fr)] px-3.5 py-2 text-xs leading-5 ${event.type === 'request_pending' ? 'bg-amber-50 text-amber-950' : 'text-zinc-700'}`}
    >
      <time
        className="tabular-nums text-zinc-400"
        dateTime={new Date(event.at).toISOString()}
      >
        {formatTime(event.at)}
      </time>
      <p>
        <EventMessage event={event} />
      </p>
    </li>
  );
}

function EventMessage({event}: {event: AgentEvent}) {
  switch (event.type) {
    case 'vault_unlocked':
      return <>Vault unlocked</>;
    case 'vault_locked':
      return (
        <>
          Vault locked <span className="text-zinc-400">({event.reason})</span>
        </>
      );
    case 'request_pending':
      return (
        <>
          <EventToken label={`Request ${event.requestId}`} value={event.requestId} />{' '}
          Pending {formatBytes(event.bytes)} signing request
        </>
      );
    case 'request_signing':
      return (
        <>
          <EventToken label={`Request ${event.requestId}`} value={event.requestId} />{' '}
          Signing via{' '}
          <EventToken
            label={`Key fingerprint ${event.fingerprint}`}
            value={event.fingerprint}
            displayValue={shortFingerprint(event.fingerprint)}
          />{' '}
          key
        </>
      );
    case 'request_closed':
      return (
        <span className="text-zinc-500">
          <EventToken label={`Request ${event.requestId}`} value={event.requestId} />{' '}
          Request closed
        </span>
      );
  }
}

interface EventTokenProps {
  label: string;
  value: string;
  displayValue?: string;
}

function EventToken({label, value, displayValue = value.slice(0, 8)}: EventTokenProps) {
  return (
    <code
      aria-label={label}
      title={value}
      className="mr-1 inline-flex rounded border border-zinc-200 bg-zinc-50 px-1 py-px text-[10px] leading-4 text-zinc-600"
    >
      {displayValue}
    </code>
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
  const encoded = fingerprint.startsWith('SHA256:')
    ? fingerprint.slice('SHA256:'.length)
    : fingerprint;

  try {
    return Array.from(atob(encoded).slice(0, 3), character =>
      character.charCodeAt(0).toString(16).padStart(2, '0'),
    ).join(':');
  } catch {
    return encoded.slice(0, 6);
  }
}
