import type {ConnectionSnapshot} from 'app/remote/session';

export function ConnectionStatus({status}: {status: ConnectionSnapshot['status']}) {
  const dotColor = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-500',
    reconnecting: 'bg-amber-500',
    rejected: 'bg-red-500',
    error: 'bg-red-500',
  }[status];

  return (
    <div className="flex justify-center">
      <p
        role="status"
        className="flex h-7 items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase shadow-xs"
      >
        <span className={`size-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
        <span className="sr-only">Connection status:</span>
        {status}
      </p>
    </div>
  );
}
