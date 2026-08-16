import type {RetainedAuthorizationRequest} from './useRetainedAuthorizationRequests';

interface AuthorizationRequestCardProps {
  request: RetainedAuthorizationRequest;
  now: number;
}

export function AuthorizationRequestCard({request, now}: AuthorizationRequestCardProps) {
  const ageSeconds = Math.max(0, Math.floor((now - request.requestedAt) / 1000));
  const deadlineSeconds = Math.max(0, Math.ceil((request.deadline - now) / 1000));
  const terminal = request.status !== 'active';
  const style = requestStyle(request.status);

  return (
    <div
      className={`${style.palette} grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-lg border px-4 py-3.5 shadow-xs transition-colors duration-200`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <time
          dateTime={new Date(request.requestedAt).toISOString()}
          className="text-foreground text-sm font-medium tabular-nums"
        >
          {formatTimestamp(request.requestedAt)}
        </time>
        <span className={`${style.muted} truncate text-[10px] leading-none tabular-nums`}>
          {formatAge(ageSeconds)}
        </span>
      </div>
      {terminal ? (
        <span
          aria-label={`Request ${request.status}`}
          className={`${style.accent} text-right text-lg font-semibold tabular-nums`}
        >
          --
        </span>
      ) : (
        <time
          dateTime={new Date(request.deadline).toISOString()}
          aria-label={`${deadlineSeconds} ${deadlineSeconds === 1 ? 'second' : 'seconds'} until deadline`}
          className="text-request-accent text-right text-lg font-semibold tabular-nums"
        >
          {deadlineSeconds}s
        </time>
      )}
      <p className="text-foreground-subtle truncate text-xs" title={request.key.name}>
        <RequestDescription request={request} />
      </p>
      <p
        className={`${style.accent} mt-1 flex items-center justify-end gap-1.5 text-[9px] font-semibold tracking-[0.14em] uppercase`}
      >
        <span
          aria-hidden="true"
          className={`${style.indicator} size-1.5 rounded-full ${terminal ? '' : 'motion-safe:animate-pulse'}`}
        />
        {request.status}
      </p>
    </div>
  );
}

function RequestDescription({request}: {request: RetainedAuthorizationRequest}) {
  const key = (
    <code className="text-foreground font-mono font-semibold">{request.key.name}</code>
  );

  switch (request.status) {
    case 'active':
      return <>Signing with {key} key</>;
    case 'signed':
      return <>Signed with {key} key</>;
    case 'expired':
      return <>Request for {key} key expired</>;
    case 'canceled':
      return <>Request for {key} key canceled</>;
  }
}

function requestStyle(status: RetainedAuthorizationRequest['status']) {
  switch (status) {
    case 'active':
      return {
        palette: 'border-request-border bg-request-surface',
        accent: 'text-request-accent',
        muted: 'text-request-muted',
        indicator: 'bg-request-accent',
      };
    case 'signed':
      return {
        palette: 'border-signed-border bg-signed-surface',
        accent: 'text-signed-accent',
        muted: 'text-signed-muted',
        indicator: 'bg-signed-accent',
      };
    case 'expired':
      return {
        palette: 'border-expired-border bg-expired-surface',
        accent: 'text-expired-accent',
        muted: 'text-expired-muted',
        indicator: 'bg-expired-accent',
      };
    case 'canceled':
      return {
        palette: 'border-border-strong bg-surface',
        accent: 'text-foreground-muted',
        muted: 'text-foreground-subtle',
        indicator: 'bg-foreground-muted',
      };
  }
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function formatAge(seconds: number): string {
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'} ago`;
}
